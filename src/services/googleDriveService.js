import { auth } from './firebase';

// Google OAuth2 configuration
const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const GOOGLE_API_KEY = process.env.REACT_APP_GOOGLE_API_KEY;
const DISCOVERY_DOCS = ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'];
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let gapiInited = false;
let gisInited = false;
let tokenClient;

// Initialize the Google API
export const initializeGoogleAPI = () => {
  return new Promise((resolve, reject) => {
    // Check if required environment variables are set
    if (!GOOGLE_CLIENT_ID || !GOOGLE_API_KEY) {
      console.warn('Google API credentials not configured. Google Drive export will be disabled.');
      reject(new Error('Google API credentials not configured'));
      return;
    }

    // Load the Google API script
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      window.gapi.load('client', async () => {
        try {
          await window.gapi.client.init({
            apiKey: GOOGLE_API_KEY,
            discoveryDocs: DISCOVERY_DOCS,
          });
          gapiInited = true;
          maybeEnableButtons();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    };
    script.onerror = () => reject(new Error('Failed to load Google API'));
    document.body.appendChild(script);

    // Load the Google Identity Services script
    const gisScript = document.createElement('script');
    gisScript.src = 'https://accounts.google.com/gsi/client';
    gisScript.onload = () => {
      try {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          callback: '', // defined later
        });
        gisInited = true;
        maybeEnableButtons();
      } catch (error) {
        reject(error);
      }
    };
    gisScript.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.body.appendChild(gisScript);
  });
};

function maybeEnableButtons() {
  if (gapiInited && gisInited) {
    // Both APIs are initialized
  }
}

// Check if user is authorized
export const isGoogleAuthorized = () => {
  return window.gapi && window.gapi.client.getToken() !== null;
};

// Request access token
export const authorizeGoogle = () => {
  return new Promise((resolve, reject) => {
    tokenClient.callback = async (resp) => {
      if (resp.error !== undefined) {
        reject(resp);
      }
      resolve(resp);
    };

    if (window.gapi.client.getToken() === null) {
      // Prompt the user to select a Google Account and ask for consent
      tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
      // Skip display of account chooser and consent dialog
      tokenClient.requestAccessToken({ prompt: '' });
    }
  });
};

// Convert markdown to HTML for Google Docs
const markdownToHtml = (markdown) => {
  // Basic markdown to HTML conversion
  let html = markdown;
  
  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  
  // Bold
  html = html.replace(/\*\*(.*)\*\*/g, '<strong>$1</strong>');
  
  // Italic
  html = html.replace(/\*(.*)\*/g, '<em>$1</em>');
  
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  
  // Code blocks
  html = html.replace(/```(.*?)```/gs, '<pre><code>$1</code></pre>');
  
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  
  // Lists
  html = html.replace(/^\* (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  
  return html;
};

// Create a Google Doc with the message content
export const saveToGoogleDocs = async (content, title = 'Claude Chat Export') => {
  try {
    // Ensure we're authorized
    if (!isGoogleAuthorized()) {
      await authorizeGoogle();
    }

    // Create a new Google Doc
    const createResponse = await window.gapi.client.drive.files.create({
      resource: {
        name: `${title} - ${new Date().toLocaleString()}`,
        mimeType: 'application/vnd.google-apps.document',
        parents: ['root']
      }
    });

    const fileId = createResponse.result.id;

    // Convert markdown to HTML
    const htmlContent = markdownToHtml(content);

    // Create the document content
    const boundary = '-------314159265358979323846';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";

    const contentType = 'text/html';
    const metadata = {
      'mimeType': contentType,
    };

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: ' + contentType + '\r\n\r\n' +
      htmlContent +
      close_delim;

    // Update the file with content
    await window.gapi.client.request({
      'path': `/upload/drive/v3/files/${fileId}`,
      'method': 'PATCH',
      'params': { 'uploadType': 'multipart' },
      'headers': {
        'Content-Type': 'multipart/related; boundary="' + boundary + '"'
      },
      'body': multipartRequestBody,
    });

    // Get the file to return its web link
    const fileResponse = await window.gapi.client.drive.files.get({
      fileId: fileId,
      fields: 'webViewLink'
    });

    return {
      success: true,
      fileId: fileId,
      webViewLink: fileResponse.result.webViewLink
    };
  } catch (error) {
    console.error('Error saving to Google Docs:', error);
    throw error;
  }
};

// Sign out from Google
export const signOutGoogle = () => {
  const token = window.gapi.client.getToken();
  if (token !== null) {
    window.google.accounts.oauth2.revoke(token.access_token);
    window.gapi.client.setToken('');
  }
};
