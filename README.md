# TruX Code

A small, dark coding workspace deployed on Cloud Run. The browser UI lives in public/index.html; the authenticated Vertex AI endpoint lives in functions/api/chat.js.

## Features

- Minimal dark workspace with a sidebar, recent chats, model selector, and Low / Medium / High thinking selector.
- Firebase Authentication with Google sign-in and email/password accounts.
- Firebase ID tokens are verified by the server before a model call.
- Vertex AI is called directly by the Cloud Run service through the Google Gen AI SDK and Application Default Credentials. No Gemini API key is used.
- Chat history is stored in this browser under the signed-in Firebase user's UID. It is not sent to Firebase Database.
- Add your logo at public/logo.png. The UI has a simple fallback if the file is not present.

## Model choices

- Gemini 4 Argon — default model, ID: gemini-4-argon.
- Gemini 3.1 Pro — ID: gemini-3.1-pro-preview.
- Gemini 3.8 Flash — ID: gemini-3.8-flash.

I could not verify an official model ID for “Gemini 3.4 Argon” in Google's current model documentation, so this app uses the verified Gemini 4 Argon model rather than sending requests to a guessed model ID. Gemini 4 Argon supports Low, Medium, and High thinking levels.

## Environment variables

Set these on Cloud Run under **Variables & Secrets → Variables**. The Firebase web configuration is public client configuration, not a server credential; still restrict the Firebase API key in Google Cloud Console to the intended APIs where applicable.

| Variable | Required | Purpose |
| --- | --- | --- |
| GOOGLE_CLOUD_PROJECT | Yes | Google Cloud project ID used for Vertex AI |
| GOOGLE_CLOUD_LOCATION | No | Vertex AI location; defaults to global |
| FIREBASE_PROJECT_ID | Yes | Firebase project ID that issues sign-in tokens; normally the same project ID |
| FIREBASE_API_KEY | Yes | Firebase web app API key |
| FIREBASE_AUTH_DOMAIN | Yes | Usually PROJECT_ID.firebaseapp.com |
| FIREBASE_APP_ID | Yes | Firebase web app app ID |
| PORT | No | Cloud Run supplies this automatically; local default is 8080 |

A starting template is in .env.example. Do not create or add a Gemini API-key variable and do not commit a service-account JSON key.

## Firebase setup

1. In Firebase Console, open Authentication → Sign-in method and enable **Google** and **Email/Password**.
2. Add the deployed Cloud Run hostname to Authentication → Settings → Authorized domains.
3. Register a Firebase Web App and copy its API key, auth domain, project ID, and app ID to the variables above.
4. Use the same Firebase project for FIREBASE_PROJECT_ID and, normally, GOOGLE_CLOUD_PROJECT.

## Vertex AI setup

1. Enable the Vertex AI API for the Google Cloud project: aiplatform.googleapis.com.
2. Give the service account used by the Cloud Run service the **Vertex AI User** role (roles/aiplatform.user).
3. Use Cloud Run's service identity / Application Default Credentials. No downloaded service-account key is needed.
4. Gemini model access, billing, and regional availability must be enabled for the project.

## Deploy to Cloud Run

From the repository root, build from source using its Dockerfile:

    gcloud run deploy trux-code --source . --region YOUR_CLOUD_RUN_REGION --allow-unauthenticated

The web service is public so Firebase sign-in can load in the browser; /api/chat itself requires a valid Firebase ID token. Then add the environment variables in the Cloud Run service configuration and redeploy.

For local development, copy .env.example to .env, fill in the values, authenticate with Google Cloud ADC, and run:

    npm install
    npm start

Keep .env out of Git. The Dockerfile listens on port 8080.

## Main structure

- functions/api/chat.js — Firebase ID-token verification and streaming Vertex AI calls.
- public/index.html — responsive dark UI, sign-in/profile, model controls, and chat history.
- server.js — Cloud Run HTTP server and public configuration endpoint.
- Dockerfile — production container.
