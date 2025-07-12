# Google OAuth Setup for Export to Google Docs

This guide will help you set up Google OAuth to enable the "Save to Google Docs" export feature.

## Prerequisites
- A Google Cloud Console account
- Access to your Firebase project

## Setup Steps

### 1. Enable Google Drive API
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (or create a new one)
3. Navigate to "APIs & Services" > "Library"
4. Search for "Google Drive API"
5. Click on it and press "Enable"

### 2. Create OAuth 2.0 Credentials
1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth client ID"
3. If prompted, configure the OAuth consent screen first:
   - Choose "External" user type
   - Fill in the required fields (app name, user support email, etc.)
   - Add your email to test users
   - Add scope: `https://www.googleapis.com/auth/drive.file`
4. For Application type, select "Web application"
5. Add authorized JavaScript origins:
   - `http://localhost:3000` (for development)
   - Your production URL
6. Add authorized redirect URIs (not required for implicit flow)
7. Click "Create"

### 3. Create API Key
1. In "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "API key"
3. Optionally restrict the key to your domains and specific APIs

### 4. Configure Environment Variables
Add these to your `.env` file:
```
REACT_APP_GOOGLE_CLIENT_ID=your_oauth_client_id_here
REACT_APP_GOOGLE_API_KEY=your_api_key_here
```

### 5. Test the Integration
1. Restart your development server
2. Send a message to Claude
3. Hover over Claude's response
4. Click the three-dot menu
5. Select "Save to Google Docs"
6. Sign in with your Google account when prompted
7. The message will be saved to your Google Drive

## Features
- **Export as PDF**: Downloads the message as a PDF file (works without Google setup)
- **Save to Google Docs**: Saves to your Google Drive as a Google Doc (requires setup)
- **Copy to Clipboard**: Copies the raw markdown text

## Troubleshooting
- If you see "(Not configured)" next to "Save to Google Docs", check your environment variables
- Make sure you've enabled the Google Drive API
- Ensure your domain is added to authorized JavaScript origins
- Check the browser console for any error messages

## Security Notes
- The app only requests `drive.file` scope, which limits access to files created by the app
- Never commit your actual API keys to version control
- Use environment variables for all sensitive credentials
