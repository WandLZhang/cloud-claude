#!/bin/bash

echo "Setting up Firebase Storage CORS configuration..."

# Check if gsutil is installed
if ! command -v gsutil &> /dev/null
then
    echo "gsutil (Google Cloud SDK) is not installed."
    echo "Please install it from: https://cloud.google.com/sdk/docs/install"
    echo ""
    echo "After installing, run:"
    echo "  gcloud auth login"
    echo "  gcloud config set project wz-cloud-claude"
    echo ""
    echo "Then run this script again."
    exit 1
fi

# Apply CORS configuration
echo "Applying CORS configuration to Firebase Storage bucket..."
gsutil cors set cors.json gs://wz-cloud-claude.firebasestorage.app

if [ $? -eq 0 ]; then
    echo "✅ CORS configuration applied successfully!"
else
    echo "❌ Failed to apply CORS configuration."
    echo "Make sure you're authenticated with gcloud and have access to the project."
    exit 1
fi

echo ""
echo "Deploying Firebase Storage rules..."
firebase deploy --only storage

if [ $? -eq 0 ]; then
    echo "✅ Storage rules deployed successfully!"
else
    echo "❌ Failed to deploy storage rules."
    echo "Make sure Firebase CLI is installed and you're logged in."
fi

echo ""
echo "Setup complete! Your app should now be able to upload images without CORS errors."
