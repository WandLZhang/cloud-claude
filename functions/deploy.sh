#!/bin/bash
set -euo pipefail

# Deploy the chat Cloud Function. Self-locating: works from any cwd.

cd "$(dirname "$0")/chat"

PROJECT_ID="wz-cloud-claude"
REGION="us-east4"
FUNCTION_NAME="chat"

echo "Deploying Cloud Function to project: $PROJECT_ID in region: $REGION"

gcloud functions deploy $FUNCTION_NAME \
  --gen2 \
  --runtime=python311 \
  --region=$REGION \
  --source=. \
  --entry-point=chat \
  --trigger-http \
  --allow-unauthenticated \
  --project=$PROJECT_ID \
  --set-env-vars=GOOGLE_CLOUD_PROJECT=$PROJECT_ID \
  --cpu=1 \
  --memory=1Gi \
  --min-instances=1 \
  --max-instances=100 \
  --timeout=3600s

echo "Cloud Function deployment complete!"
echo ""
echo "Function URL: https://$REGION-$PROJECT_ID.cloudfunctions.net/$FUNCTION_NAME"
echo ""
echo "Add this URL to your frontend .env file:"
echo "REACT_APP_CLOUD_FUNCTION_URL=https://$REGION-$PROJECT_ID.cloudfunctions.net/$FUNCTION_NAME"
