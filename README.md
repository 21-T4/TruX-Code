# TruX Code

A minimal dark coding workspace for Cloud Run. The browser UI lives in `public/index.html`; the authenticated, streaming Vertex AI endpoint lives in `functions/api/chat.js`.

## Features

- Dark workspace with a sidebar, centered AI-generated welcome, recent chats, model selector, and Low / Medium / High thinking.
- Firebase Authentication with Google sign-in and email/password accounts.
- Firebase ID tokens are verified by the backend before a model request.
- Vertex AI is called directly through the Google Gen AI SDK and Cloud Run Application Default Credentials. No Gemini API key or downloaded service-account key is used.
- Chat history is stored in the browser under the signed-in Firebase user's UID, not in Firebase Database.
- Add your logo at `public/logo.png`.

## Runtime configuration file

Google Cloud and Firebase project settings are stored in `config/runtime-config.json`. This file is outside the `public/` directory and is not served as a static asset. The Express app also explicitly returns 404 for requests under `/config`. The Dockerfile copies the file into the server container so the backend can read it.

The configuration uses the settings already present in the private TruX-AI repository:

- Google Cloud / Firebase project: `trux-ai`
- Vertex AI location: `global`
- Firebase Auth domain: `trux-ai.firebaseapp.com`
- Firebase storage bucket: `trux-ai.firebasestorage.app`
- Firebase web app ID: `1:59313097411:web:32e4158bfb733fa7cfb076`
- Firebase messaging sender ID: `59313097411`
- Firebase measurement ID: `G-C32LC29QHC`

### Important security distinction

The file itself is not exposed as a web path. However, the Firebase configuration is **client configuration**, not a password: the browser needs it to initialize Firebase Authentication. The server returns those client values from `/api/config`, so website visitors can inspect those values in their browser's network tools. Google's Firebase documentation explicitly says Firebase config values and Firebase service API keys are public by design; access protection must come from Firebase Authentication, Security Rules, App Check where applicable, and API restrictions.

Do not place service-account private keys, Composio keys, Gemini Developer API keys, passwords, or other genuine secrets in this JSON file. Cloud Run uses its attached service identity for Vertex AI. If a future feature needs a genuinely secret value, store it in Google Secret Manager and mount it into the container as a file; do not commit that secret to this repository.

## Model choices

- Gemini 4 Argon — default model ID: `gemini-4-argon`.
- Gemini 3.1 Pro — `gemini-3.1-pro-preview`.
- Gemini 3.8 Flash — `gemini-3.8-flash`.

The implementation does not guess a model ID for “Gemini 3.4 Argon,” which I could not verify. Model availability depends on the project's Vertex AI access and the selected location.

## Firebase setup

1. In Firebase Console, open Authentication → Sign-in method and enable **Google** and **Email/Password**.
2. Add your deployed Cloud Run hostname to Authentication → Settings → Authorized domains.
3. Verify that the Firebase web app in `config/runtime-config.json` is the intended one for project `trux-ai`.
4. Configure appropriate API restrictions for the Firebase browser API key and secure Firebase data using the relevant Security Rules. Do not rely on hiding a Firebase web API key.

## Vertex AI setup

1. Enable the Vertex AI API (`aiplatform.googleapis.com`) in the `trux-ai` Google Cloud project.
2. Give the Cloud Run service identity the **Vertex AI User** role (`roles/aiplatform.user`).
3. Use Cloud Run Application Default Credentials. Do not download or commit a service-account JSON key.
4. Make sure billing, model access, and availability are enabled for the chosen model and location.

## Deploy to Cloud Run

From the repository root:

    gcloud run deploy trux-code --source . --region YOUR_CLOUD_RUN_REGION --allow-unauthenticated

No Firebase or Vertex AI environment variables are required by this implementation: those settings are read from `config/runtime-config.json`. Cloud Run supplies `PORT` automatically. The web app is public so Firebase sign-in can load in a browser, but `/api/chat` requires a valid Firebase ID token.

For local development, install dependencies and authenticate with Google Cloud Application Default Credentials:

    npm install
    npm start

Optional local server port: set `PORT` in your local shell. `.env.example` contains only that optional setting. Keep local `.env` files and service credentials out of Git.

## Main structure

- `config/runtime-config.json` — Google Cloud and Firebase app configuration, outside the static web root.
- `functions/api/chat.js` — token verification and streamed Vertex AI responses.
- `public/index.html` — responsive dark UI, sign-in/profile, model controls, and local chat history.
- `server.js` — Cloud Run HTTP server, Firebase client-config endpoint, and the explicit non-public config-path block.
- `Dockerfile` — production container image.

## Firebase authentication and session security

- Email/password accounts are created in Firebase Authentication. Passwords are handled by Firebase Auth and must never be copied into Firestore, cookies, localStorage, logs, or application-owned profile records.
- After sign-in, the server exchanges the Firebase ID token for a 14-day session cookie. On HTTPS deployments the cookie is `__Host-trux_code_session`, with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain` attribute.
- Firebase client auth is kept in memory only; the HTTP-only server cookie restores the client state after a reload, avoiding long-lived Firebase refresh tokens in localStorage. A new cookie requires recent authentication, while a still-valid matching server session can be renewed. Session endpoints are same-origin protected, responses are not cached, and protected chat requests verify Firebase sessions with revocation checks enabled.
- Cloud Run should use its attached runtime service account through Application Default Credentials. Do not create or commit a service-account JSON key. The runtime identity needs only the Firebase Authentication permissions required by these endpoints. Custom-token session restoration also requires `iam.serviceAccounts.signBlob` on the signing service account (commonly granted through `roles/iam.serviceAccountTokenCreator`); scope that grant narrowly.
- Enable the Email/Password provider in Firebase Authentication and add the production app hostname to Firebase Authentication's authorized domains. Set `APP_ORIGIN` only when the app uses a different public origin; provide the origin without a trailing slash.
- The server cookie has a maximum lifetime of 14 days, the Firebase Admin SDK's supported upper limit for session cookies. Returning activity refreshes it; a browser that remains unused past expiry must authenticate again.
