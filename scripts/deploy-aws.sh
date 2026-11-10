#!/usr/bin/env bash
# Deploy the latest origin/main to the EECStime EC2 server.
#
#   bash scripts/deploy-aws.sh            # after `git push`
#
# Runs the update on the instance through SSM (no SSH needed), keeping the
# site up:
#  - Code-only changes: check out origin/main; source folders are mounted into
#    the dev containers, so Vite and the backend hot-reload. No restarts.
#  - Dependency/Dockerfile/compose changes: first build the new images from a
#    separate checkout (/opt/eecstime-build) while the live site keeps running,
#    then switch the code and recreate just the changed containers.
#  - The datapuller restarts if its code changed; nginx reloads its config.
# Ends with a health check. The server's .env is untracked and never touched.
#
# Env overrides: AWS_REGION (default us-west-2), INSTANCE_ID (default: the
# running instance tagged Name=eecstime).
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-west-2}"
REPO_URL="https://github.com/mr-mph/eecstime.git"

# Deploys come from GitHub, so warn about work that isn't there yet.
git fetch -q origin main
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: you have uncommitted changes; they won't be deployed."
fi
if [ -n "$(git log --oneline origin/main..HEAD)" ]; then
  echo "Note: local commits not pushed to origin/main won't be deployed:"
  git log --oneline origin/main..HEAD | sed 's/^/  /'
fi
echo "Deploying origin/main ($(git log -1 --format='%h %s' origin/main))"

INSTANCE_ID="${INSTANCE_ID:-$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=tag:Name,Values=eecstime Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)}"
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "No running instance tagged Name=eecstime in $REGION." >&2
  exit 1
fi

# Runs on the server as root.
read -r -d '' REMOTE <<EOF || true
set -euo pipefail
export HOME=/root PATH=\$PATH:/snap/bin
LIVE=/opt/eecstime
BUILD=/opt/eecstime-build
cd \$LIVE
git remote get-url origin >/dev/null 2>&1 || git remote add origin $REPO_URL
before=\$(git rev-parse -q --verify HEAD || echo none)
git fetch -q origin main
after=\$(git rev-parse origin/main)
if [ "\$before" = "\$after" ]; then
  echo "Already at \$(git log -1 --format='%h %s' "\$after")"
  changed=""
elif [ "\$before" = none ]; then
  changed=\$(git ls-tree -r --name-only "\$after")
else
  echo "Updating \${before:0:9} -> \${after:0:9}:"
  git log --format='  %h %s' "\$before..\$after" | head -20
  changed=\$(git diff --name-only "\$before" "\$after")
fi

# Images only need rebuilding when dependencies or Docker config change.
rebuild=false
echo "\$changed" | grep -qE '(^|/)(package(-lock)?\.json|Dockerfile)\$|^docker-compose\.ya?ml\$' && rebuild=true

if \$rebuild; then
  # Build new images from a separate checkout so the live site keeps running
  # the current code (and its matching installed packages) during the build.
  echo "==> Building updated images (live site untouched)"
  if [ -d \$BUILD/.git ] || [ -f \$BUILD/.git ]; then
    git -C \$BUILD checkout -q -f --detach "\$after"
  else
    git worktree add -q -f --detach \$BUILD "\$after"
  fi
  cp \$LIVE/.env \$BUILD/.env
  (cd \$BUILD && docker compose -p eecstime build) >/tmp/deploy-build.log 2>&1 || { tail -30 /tmp/deploy-build.log; exit 1; }
fi

# Switch the live code. Source folders are mounted into the dev containers,
# so Vite and the backend pick this up through hot reload.
git checkout -q -f -B main "\$after"
git branch -q -u origin/main

if \$rebuild; then
  # Recreate only the containers whose image changed (a short restart).
  echo "==> Swapping in rebuilt containers"
  docker compose up -d >/tmp/deploy-compose.log 2>&1 || { tail -30 /tmp/deploy-compose.log; exit 1; }
  # nginx resolves container addresses at startup; pick up the new ones.
  docker compose exec -T nginx nginx -s reload >/dev/null 2>&1 || docker compose restart nginx >/dev/null 2>&1
  echo "==> npm install (dependencies changed)"
  npm install --no-audit --no-fund --loglevel=error >/tmp/deploy-npm.log 2>&1 || { tail -20 /tmp/deploy-npm.log; exit 1; }
fi
if [ -n "\$changed" ]; then
  echo "==> Generating GraphQL types"
  npx turbo run generate >/tmp/deploy-generate.log 2>&1 || { tail -20 /tmp/deploy-generate.log; exit 1; }
fi

# Background jobs only; visitors never notice.
if echo "\$changed" | grep -qE '^(apps/datapuller|packages|scripts)/'; then
  echo "==> Restarting datapuller"
  docker compose restart datapuller >/dev/null 2>&1
fi
if echo "\$changed" | grep -qE '^nginx\.conf\$'; then
  echo "==> Reloading nginx config"
  docker compose exec -T nginx nginx -s reload >/dev/null 2>&1
fi

echo "==> Health check"
for i in \$(seq 1 30); do
  site=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ || true)
  api=\$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
    --data '{"query":"{__typename}"}' http://localhost:3000/api/graphql || true)
  [ "\$site" = 200 ] && [ "\$api" = 200 ] && break
  sleep 5
done
echo "site \$site, api \$api"
docker compose ps --format '  {{.Name}}: {{.Status}}'
[ "\$site" = 200 ] && [ "\$api" = 200 ]
EOF

# SSM runs commands with sh; feed the script to bash.
PARAMS="$(python3 -c 'import json,sys; print(json.dumps({"commands":["bash -s <<'"'"'DEPLOY_EOF'"'"'\n" + sys.stdin.read() + "\nDEPLOY_EOF"],"executionTimeout":["3600"]}))' <<<"$REMOTE")"
COMMAND_ID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --comment "deploy origin/main" \
  --parameters "$PARAMS" --query Command.CommandId --output text)"
echo "Running on $INSTANCE_ID (SSM command $COMMAND_ID)..."

while :; do
  sleep 5
  STATUS="$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in Pending|InProgress|Delayed) continue ;; esac
  break
done

aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text
if [ "$STATUS" != Success ]; then
  aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" --query StandardErrorContent --output text | tail -20
  echo "Deploy failed ($STATUS)." >&2
  exit 1
fi
echo "Deploy succeeded."
