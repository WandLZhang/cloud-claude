# Cloud Claude Chat

A mobile-friendly Firebase chat application with Claude AI integration, featuring thinking mode, image support, and prompt caching.

## Features

- 🔐 Google Authentication via Firebase
- 💬 Real-time chat with Claude Opus 4
- 🧠 Claude thinking mode with 6,553 token budget
- 📸 Image upload support
- 💾 Prompt caching for better performance
- 🌓 Light/Dark theme support
- 📱 Mobile-optimized interface
- 💻 Material Design styling

## Prerequisites

- Node.js (v14+)
- Python 3.11+
- Google Cloud Project with billing enabled
- Firebase project
- Access to Claude API via Vertex AI

## Setup Instructions

### 1. Clone the repository

```bash
cd cloud-claude-chat
```

### 2. Set up Firebase

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project or use existing one (e.g., `wz-cloud-claude`)
3. Enable Authentication and add Google as a sign-in provider
4. Enable Firestore Database
5. Get your Firebase configuration from Project Settings

### 3. Configure environment variables

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Update the values in `.env`:
- Add your Firebase configuration values
- Update the Cloud Function URL after deployment

### 4. Deploy the Cloud Function

```bash
chmod +x functions/deploy.sh
functions/deploy.sh
```

This will deploy the `chat` function to `us-east4`. The script is self-locating, so it works from any cwd. Note the function URL it prints and update your `.env`.

### 5. Install dependencies and run

```bash
cd ..
npm install
npm start
```

The app will open at http://localhost:3000

## Deployment

### Deploy Cloud Function

```bash
functions/deploy.sh
```

### Deploy to Firebase Hosting

```bash
npm run build
firebase deploy --only hosting
```

## Project Structure

```
cloud-claude-chat/
├── public/              # Static files
├── src/
│   ├── components/      # React components
│   │   ├── Auth/       # Authentication components
│   │   ├── Chat/       # Chat interface components
│   │   ├── Common/     # Shared components
│   │   └── Layout/     # Layout components
│   ├── hooks/          # Custom React hooks
│   ├── services/       # API and Firebase services
│   └── material.css    # Material Design styles
├── functions/             # Python (Cloud Functions + ops scripts)
│   ├── chat/             # Deployed Cloud Function: Claude API integration
│   │   ├── main.py
│   │   ├── requirements.txt
│   │   └── .gcloudignore
│   ├── scripts/          # One-off ops scripts (run locally, not deployed)
│   │   └── backfill_message_userid.py
│   └── deploy.sh         # Deploys functions/chat/ to us-east4
├── firestore.rules        # Firestore security rules
├── firestore.indexes.json # Firestore composite indexes
└── firebase.json          # Firebase configuration
```

## Configuration

### Cloud Function Environment

The Cloud Function is configured to:
- Use Claude Opus 4 model (`claude-opus-4@20250514`)
- Support up to 8,192 output tokens
- Enable thinking mode with 6,553 token budget
- Use prompt caching for better performance

### Firebase Security Rules

The Firestore rules ensure users can only access their own chat data:

```javascript
match /chats/{userId}/{document=**} {
  allow read, write: if request.auth != null && request.auth.uid == userId;
}
```

## Usage

1. Sign in with your Google account
2. Start chatting with Claude
3. Upload images by clicking the attachment icon or drag & drop
4. View Claude's thinking process by expanding the thinking section
5. Toggle between light and dark themes

## Development

### Running locally

```bash
npm start
```

### Building for production

```bash
npm run build
```

### Testing the Cloud Function locally

```bash
cd functions/chat
functions-framework --target=chat --debug
```

## Troubleshooting

### Authentication issues
- Ensure your domain is added to Firebase Auth authorized domains
- Check that Google sign-in is enabled in Firebase Console

### Cloud Function errors
- Verify the function is deployed to the correct region
- Check that the Vertex AI API is enabled in your GCP project
- Ensure proper IAM permissions for the service account

### Build issues
- Clear npm cache: `npm cache clean --force`
- Delete node_modules and reinstall: `rm -rf node_modules && npm install`

## License

MIT

## Acknowledgments

- Built with React and Firebase
- Powered by Claude AI via Google Vertex AI
- Styled with Material Design principles
