#!/usr/bin/env bash
# Deploy the latest origin/main to the EECStime Azure server.
#
#   bash scripts/deploy-azure.sh            # after `git push`
#
# Sends scripts/deploy-remote.sh to the VM through Azure run-command (no SSH
# or open ports needed) and prints its output. Needs `az login`.
#
# Env overrides: AZURE_RESOURCE_GROUP (default rg-eecstime),
# AZURE_VM (default eecstime).
set -euo pipefail

cd "$(dirname "$0")/.."
RG="${AZURE_RESOURCE_GROUP:-rg-eecstime}"
VM="${AZURE_VM:-eecstime}"

# Deploys come from GitHub, so warn about work that isn't there yet.
git fetch -q origin main
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: you have uncommitted changes; they won't be deployed."
fi
if [ -n "$(git log --oneline origin/main..HEAD)" ]; then
  echo "Note: local commits not pushed to origin/main won't be deployed:"
  git log --oneline origin/main..HEAD | sed 's/^/  /'
fi
echo "Deploying origin/main ($(git log -1 --format='%h %s' origin/main)) to $VM..."

OUTPUT="$(az vm run-command invoke -g "$RG" -n "$VM" --command-id RunShellScript \
  --scripts @scripts/deploy-remote.sh --query "value[0].message" -o tsv)"
printf '%s\n' "$OUTPUT" | sed -e '/^Enable succeeded: *$/d' -e '/^\[stdout\]$/d' -e '/^\[stderr\]$/d'

# run-command reports success even when the script fails; check the health line.
if printf '%s\n' "$OUTPUT" | grep -q '^site 200, api 200$'; then
  echo "Deploy succeeded."
else
  echo "Deploy failed (see output above)." >&2
  exit 1
fi
