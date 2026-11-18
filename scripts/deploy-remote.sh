#!/bin/bash
# Server-side deploy for the EECStime server: runs as root on the server,
# sent by scripts/deploy-azure.sh (Azure run-command) or
# scripts/deploy-aws.sh (AWS SSM). Not meant to be run on your Mac.
#
#  - Frontend: served as a static production build (nginx.server.conf). Each
#    frontend change builds a new release in /opt/eecstime-site/releases and
#    switches the current symlink atomically; the last 3 are kept.
#  - Backend: source is mounted into its container and hot-reloads.
#  - Dependency/Dockerfile/compose changes: build the new images first from a
#    separate checkout (/opt/eecstime-build) while the live site keeps running,
#    then switch the code and recreate just the changed containers.
#  - The datapuller restarts if its code changed.
# Ends with a health check. The server's .env is untracked and never touched.
set -euo pipefail
export HOME=/root PATH=$PATH:/snap/bin
LIVE=/opt/eecstime
BUILD=/opt/eecstime-build
cd $LIVE
git remote get-url origin >/dev/null 2>&1 || git remote add origin https://github.com/mr-mph/eecstime.git
before=$(git rev-parse -q --verify HEAD || echo none)
git fetch -q origin main
after=$(git rev-parse origin/main)
if [ "$before" = "$after" ]; then
  echo "Already at $(git log -1 --format='%h %s' "$after")"
  changed=""
elif [ "$before" = none ]; then
  changed=$(git ls-tree -r --name-only "$after")
else
  echo "Updating ${before:0:9} -> ${after:0:9}:"
  git log --format='  %h %s' "$before..$after" | head -20
  changed=$(git diff --name-only "$before" "$after")
fi

# Images only need rebuilding when dependencies or Docker config change.
rebuild=false
echo "$changed" | grep -qE '(^|/)(package(-lock)?\.json|Dockerfile)$|^docker-compose\.ya?ml$' && rebuild=true

if $rebuild; then
  # Build new images from a separate checkout so the live site keeps running
  # the current code (and its matching installed packages) during the build.
  echo "==> Building updated images (live site untouched)"
  if [ -d $BUILD/.git ] || [ -f $BUILD/.git ]; then
    git -C $BUILD checkout -q -f --detach "$after"
  else
    git worktree add -q -f --detach $BUILD "$after"
  fi
  cp $LIVE/.env $BUILD/.env
  (cd $BUILD && docker compose -p eecstime build) >/tmp/deploy-build.log 2>&1 || { tail -30 /tmp/deploy-build.log; exit 1; }
fi

# Switch the live code. The backend's source is mounted into its container
# and hot-reloads; the frontend is a static build (below).
git checkout -q -f -B main "$after"
git branch -q -u origin/main

if $rebuild; then
  echo "==> npm install (dependencies changed)"
  npm install --no-audit --no-fund --loglevel=error >/tmp/deploy-npm.log 2>&1 || { tail -20 /tmp/deploy-npm.log; exit 1; }
fi
if [ -n "$changed" ]; then
  echo "==> Generating GraphQL types"
  npx turbo run generate >/tmp/deploy-generate.log 2>&1 || { tail -20 /tmp/deploy-generate.log; exit 1; }
fi

# Build a new frontend release next to the live one, then switch the
# current symlink atomically: visitors get the old or the new build, never
# a half-written one. Keeps the last 3 releases for quick rollback.
SITE=/opt/eecstime-site
first_static=false
[ -e $SITE/current ] || first_static=true
if $first_static || echo "$changed" | grep -qE '^(apps/frontend|packages)/|(^|/)package-lock\.json$'; then
  echo "==> Building frontend release"
  # npm skips Rollup's native binary when the lockfile was made on another
  # platform (npm/cli#4828); vite build needs it.
  node -e "require('@rollup/rollup-' + process.platform + '-' + process.arch + '-gnu')" 2>/dev/null ||     npm install --no-save --no-audit --no-fund --loglevel=error       "@rollup/rollup-$(node -p "process.platform+'-'+process.arch")-gnu@$(node -p "require('rollup/package.json').version")"       >/tmp/deploy-rollup.log 2>&1 || { tail -20 /tmp/deploy-rollup.log; exit 1; }
  release=$(date -u +%Y%m%d%H%M%S)-${after:0:9}
  mkdir -p $SITE/releases
  (cd apps/frontend && npx vite build --outDir $SITE/releases/$release --emptyOutDir --logLevel error) >/tmp/deploy-vite.log 2>&1 || { tail -30 /tmp/deploy-vite.log; exit 1; }
  ln -sfn releases/$release $SITE/current.tmp && mv -Tf $SITE/current.tmp $SITE/current
  ls -1dt $SITE/releases/* | tail -n +4 | xargs -r rm -rf
fi

# Serve the frontend from that static build (docker-compose.server.yml,
# nginx.server.conf) instead of the Vite dev server. One-time switch, only
# once a release exists.
grep -q '^COMPOSE_FILE=' .env || echo "COMPOSE_FILE=docker-compose.yml:docker-compose.server.yml" >> .env

if $rebuild || $first_static || echo "$changed" | grep -qE '^(nginx\.server\.conf|docker-compose\.server\.yml)$'; then
  # Recreate only containers whose image or config changed (a short restart).
  echo "==> Applying container changes"
  docker compose up -d >/tmp/deploy-compose.log 2>&1 || { tail -30 /tmp/deploy-compose.log; exit 1; }
  # A single-file bind mount keeps the old nginx.server.conf after checkout.
  echo "$changed" | grep -qE '^nginx\.server\.conf$' && docker compose up -d --force-recreate --no-deps nginx >/dev/null 2>&1
  # The Vite dev server isn't used on the server any more.
  docker rm -f eecstime-frontend-1 >/dev/null 2>&1 || true
fi

# Background jobs only; visitors never notice.
if echo "$changed" | grep -qE '^(apps/datapuller|packages|scripts)/'; then
  echo "==> Restarting datapuller"
  docker compose restart datapuller >/dev/null 2>&1
fi

echo "==> Health check"
for i in $(seq 1 30); do
  site=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ || true)
  api=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json'     --data '{"query":"{__typename}"}' http://localhost:3000/api/graphql || true)
  [ "$site" = 200 ] && [ "$api" = 200 ] && break
  sleep 5
done
echo "site $site, api $api"
docker compose ps --format '  {{.Name}}: {{.Status}}'
[ "$site" = 200 ] && [ "$api" = 200 ]
