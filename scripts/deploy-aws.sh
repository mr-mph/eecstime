#!/usr/bin/env bash
# Deploy the latest origin/main to the EECStime EC2 server (the old AWS host;
# the site now runs on Azure: use scripts/deploy-azure.sh).
#
#   bash scripts/deploy-aws.sh            # after `git push`
#
# Runs the update on the instance through SSM (no SSH needed), keeping the
# site up:
#  - Frontend: served as a static production build (nginx.server.conf). Each
#    frontend change builds a new release in /opt/eecstime-site/releases and
#    switches the `current` symlink atomically; the last 3 are kept.
#  - Backend: source is mounted into its container and hot-reloads. No restart.
#  - Dependency/Dockerfile/compose changes: first build the new images from a
#    separate checkout (/opt/eecstime-build) while the live site keeps running,
#    then switch the code and recreate just the changed containers.
#  - The datapuller restarts if its code changed.
# Ends with a health check. The server's .env is untracked and never touched.
#
# Env overrides: AWS_REGION (default us-west-2), INSTANCE_ID (default: the
# running instance tagged Name=eecstime).
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-west-2}"

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

# The server-side steps live in scripts/deploy-remote.sh (shared with Azure).
REMOTE="$(cat scripts/deploy-remote.sh)"

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
