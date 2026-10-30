#!/usr/bin/env bash
# Deploy / update the EECStime enrollment worker.
#
#   bash infra/enrollment-worker/deploy.sh            # from repo root
#
# 1. CloudFormation stack (bucket, Lambda, 5-minute schedule, sync IAM user,
#    status dashboard Lambda + public URL)
# 2. Bundles src/handler.ts with esbuild and uploads it to the Lambda
# 3. On first deploy, creates an access key for the sync user and writes the
#    ENROLLMENT_WORKER_* settings into the repo's .env for the datapuller
#
# Env overrides: AWS_REGION (default us-west-2), MAX_RPS (default 1),
# MEMORY_MB (default 192), CONCURRENCY (default 2), MAX_CONCURRENCY (default 4),
# RESERVE_CONCURRENCY (default false; needs an account limit above 10),
# WORKER_ENABLED (true/false; default: keep the current state).
set -euo pipefailzo

cd "$(dirname "$0")/../.."
REGION="${AWS_REGION:-us-west-2}"
STACK=eecstime-enrollment-worker
OUT=infra/enrollment-worker/dist

# Keep the worker's current on/off state unless WORKER_ENABLED is given, so a
# redeploy never silently restarts a worker that was stopped (e.g. blocked).
if [ -z "${WORKER_ENABLED:-}" ]; then
  current="$(aws scheduler get-schedule --region "$REGION" --name "$STACK" \
    --query State --output text 2>/dev/null || echo ENABLED)"
  WORKER_ENABLED=$([ "$current" = "DISABLED" ] && echo false || echo true)
fi
echo "==> Deploying stack $STACK ($REGION), worker enabled: $WORKER_ENABLED"
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file infra/enrollment-worker/template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "MaxRequestsPerSecond=${MAX_RPS:-1}" \
    "MemorySize=${MEMORY_MB:-192}" \
    "Concurrency=${CONCURRENCY:-2}" \
    "MaxConcurrency=${MAX_CONCURRENCY:-4}" \
    "ReserveConcurrency=${RESERVE_CONCURRENCY:-false}" \
    "WorkerEnabled=$WORKER_ENABLED" \
  --no-fail-on-empty-changeset

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET="$(output BucketName)"
FUNCTION="$(output FunctionName)"
SYNC_USER="$(output SyncUserName)"
STATUS_FUNCTION="$(output StatusFunctionName)"
STATUS_URL="$(output StatusUrl)"

bundle() { # <entry> <name>
  mkdir -p "$OUT/$2"
  npx esbuild "infra/enrollment-worker/src/$1" \
    --bundle --platform=node --target=node22 --format=cjs \
    --external:@aws-sdk/* --outfile="$OUT/$2/index.js" --log-level=warning
  (cd "$OUT/$2" && zip -q ../$2.zip index.js)
}

echo "==> Checking the dashboard page's script parses"
npx tsx -e '
import { DASHBOARD_HTML } from "./infra/enrollment-worker/src/status-page.ts";
const js = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf("<script>") + 8, DASHBOARD_HTML.lastIndexOf("</script>"));
new Function(js);
'

echo "==> Bundling worker + status dashboard"
rm -rf "$OUT" && mkdir -p "$OUT"
bundle handler.ts worker
bundle status.ts status

echo "==> Uploading code to $FUNCTION and $STATUS_FUNCTION"
aws lambda update-function-code --region "$REGION" \
  --function-name "$FUNCTION" --zip-file "fileb://$OUT/worker.zip" \
  --query 'LastUpdateStatus' --output text
aws lambda update-function-code --region "$REGION" \
  --function-name "$STATUS_FUNCTION" --zip-file "fileb://$OUT/status.zip" \
  --query 'LastUpdateStatus' --output text

if grep -q '^ENROLLMENT_WORKER_ACCESS_KEY_ID=.\+' .env 2>/dev/null; then
  echo "==> .env already has ENROLLMENT_WORKER_* settings; leaving them"
else
  echo "==> Creating access key for $SYNC_USER and writing it to .env"
  read -r KEY_ID SECRET < <(aws iam create-access-key --user-name "$SYNC_USER" \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
  sed -i.bak '/^ENROLLMENT_WORKER_/d' .env && rm -f .env.bak
  {
    echo ""
    echo "# AWS enrollment worker (infra/enrollment-worker)"
    echo "ENROLLMENT_WORKER_BUCKET=$BUCKET"
    echo "ENROLLMENT_WORKER_REGION=$REGION"
    echo "ENROLLMENT_WORKER_ACCESS_KEY_ID=$KEY_ID"
    echo "ENROLLMENT_WORKER_SECRET_ACCESS_KEY=$SECRET"
  } >> .env
fi

echo "==> Done. Bucket: $BUCKET  Function: $FUNCTION"
echo "    Status dashboard: $STATUS_URL"
echo "    Restart the datapuller so it picks up .env:"
echo "    docker compose up -d --force-recreate datapuller"
