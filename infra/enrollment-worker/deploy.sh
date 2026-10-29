#!/usr/bin/env bash
# Deploy / update the EECStime enrollment worker.
#
#   bash infra/enrollment-worker/deploy.sh            # from repo root
#
# 1. CloudFormation stack (bucket, Lambda, 5-minute schedule, sync IAM user)
# 2. Bundles src/handler.ts with esbuild and uploads it to the Lambda
# 3. On first deploy, creates an access key for the sync user and writes the
#    ENROLLMENT_WORKER_* settings into the repo's .env for the datapuller
#
# Env overrides: AWS_REGION (default us-west-2), MAX_RPS (default 1),
# MEMORY_MB (default 192),
# RESERVE_CONCURRENCY (default false; needs an account limit above 10).
set -euo pipefail

cd "$(dirname "$0")/../.."
REGION="${AWS_REGION:-us-west-2}"
STACK=eecstime-enrollment-worker
OUT=infra/enrollment-worker/dist

echo "==> Deploying stack $STACK ($REGION)"
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file infra/enrollment-worker/template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "MaxRequestsPerSecond=${MAX_RPS:-1}" \
    "MemorySize=${MEMORY_MB:-192}" \
    "ReserveConcurrency=${RESERVE_CONCURRENCY:-false}" \
  --no-fail-on-empty-changeset

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET="$(output BucketName)"
FUNCTION="$(output FunctionName)"
SYNC_USER="$(output SyncUserName)"

echo "==> Bundling worker"
rm -rf "$OUT" && mkdir -p "$OUT"
npx esbuild infra/enrollment-worker/src/handler.ts \
  --bundle --platform=node --target=node22 --format=cjs \
  --external:@aws-sdk/* --outfile="$OUT/index.js"
(cd "$OUT" && zip -q worker.zip index.js)

echo "==> Uploading code to $FUNCTION"
aws lambda update-function-code --region "$REGION" \
  --function-name "$FUNCTION" --zip-file "fileb://$OUT/worker.zip" \
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
echo "    Restart the datapuller so it picks up .env:"
echo "    docker compose up -d --force-recreate datapuller"
