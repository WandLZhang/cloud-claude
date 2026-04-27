#!/bin/bash
set -euo pipefail

# Deploy Cloud Functions. Self-locating: works from any cwd.
#
# Usage:
#   ./deploy.sh             # deploys all functions
#   ./deploy.sh chat        # deploys only the chat function
#   ./deploy.sh wrap_chinese
#

FUNCTIONS_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ID="wz-cloud-claude"
REGION="us-east4"

deploy_function() {
  local FUNCTION_NAME="$1"
  local SOURCE_DIR="$FUNCTIONS_DIR/$FUNCTION_NAME"

  if [ ! -d "$SOURCE_DIR" ]; then
    echo "ERROR: source dir not found: $SOURCE_DIR" >&2
    return 1
  fi

  echo
  echo "============================================================"
  echo "Deploying $FUNCTION_NAME to $PROJECT_ID/$REGION"
  echo "============================================================"

  cd "$SOURCE_DIR"

  gcloud functions deploy "$FUNCTION_NAME" \
    --gen2 \
    --runtime=python311 \
    --region="$REGION" \
    --source=. \
    --entry-point="$FUNCTION_NAME" \
    --trigger-http \
    --allow-unauthenticated \
    --project="$PROJECT_ID" \
    --set-env-vars=GOOGLE_CLOUD_PROJECT="$PROJECT_ID" \
    --cpu=1 \
    --memory=1Gi \
    --min-instances=1 \
    --max-instances=100 \
    --timeout=3600s

  echo
  echo "$FUNCTION_NAME deployed: https://$REGION-$PROJECT_ID.cloudfunctions.net/$FUNCTION_NAME"
}

if [ $# -eq 0 ]; then
  TARGETS=(chat wrap_chinese)
else
  TARGETS=("$@")
fi

for fn in "${TARGETS[@]}"; do
  deploy_function "$fn"
done

echo
echo "All requested deployments complete."
echo
echo "URLs to wire into the frontend (.env):"
echo "  REACT_APP_CLOUD_FUNCTION_URL=https://$REGION-$PROJECT_ID.cloudfunctions.net/chat"
echo "  REACT_APP_WRAP_CHINESE_URL=https://$REGION-$PROJECT_ID.cloudfunctions.net/wrap_chinese"
