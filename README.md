# TruX Code

A minimal dark coding workspace for Cloud Run. The browser UI lives in `public/index.html`; the authenticated, streaming Vertex AI endpoint lives in `functions/api/chat.js`.

## Features

- Dark workspace with a sidebar, centered AI-generated welcome, recent chats, model selector, and Low / Medium / High thinking.
- Firebase Authentication with Google sign-in and email/password accounts.
- The backend verifies the HttpOnly Firebase session cookie before chat, profile, and history requests (and accepts a Firebase ID token for compatible clients).
- Vertex AI is called directly through the Google Gen AI SDK and Cloud Run Application Default Credentials. No Gemini API key or downloaded service-account key is used.
- Google sign-in automatically creates or returns a Firebase Authentication account with a unique UID; the same Firebase project can provide the shared TruX account identity.
- Firebase Authentication is the canonical TruX account. The first Google sign-in creates a unique Auth UID; later sign-ins reuse that same account. The server syncs a Firestore profile at `users/{uid}` when Firestore is available, and cloud chats live at `users/{uid}/chats/{chatId}` with ordered message documents. The browser also keeps an account-specific local cache.
- Chat, profile, and session API routes derive the owner from the verified Firebase session, never from a client-supplied UID.
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

## Firebase and Firestore setup

1. In Firebase Console, open Authentication → Sign-in method and enable **Google** and (if desired) **Email/Password**. Google sign-in automatically creates a unique Firebase Auth UID for a first-time account; no separate password is stored by TruX Code.
2. Add `trux-code.trux.website` to Authentication → Settings → Authorized domains. Confirm the same Firebase project (`trux-ai`) is used by the TruX app whose account identity should be shared.
3. In the Google Cloud project `trux-ai`, create/enable the **default Cloud Firestore database** in Native mode and choose the appropriate region. The server uses the Admin SDK, so browser Firestore rules do not authorize these server requests; the server derives each user UID from the validated session cookie.
4. Grant the Cloud Run service identity `roles/datastore.user` for Firestore read/write access and `roles/firebaseauth.admin` (or a narrower equivalent) for the account profile update endpoint. Keep those roles scoped to the service identity.
5. Verify that `config/runtime-config.json` contains the intended Firebase web app settings. Configure appropriate API restrictions for the Firebase browser API key and secure any other Firebase data with the relevant Security Rules; do not rely on hiding a Firebase web API key.

**Firebase account sign-in does not depend on Firestore being available.** Google sign-in creates or reuses the Firebase Authentication account and the server establishes the secure session. Creating or refreshing `users/{uid}` in Firestore is best-effort, so a temporary Firestore outage cannot block account access. Cloud chat history still requires the default Firestore database and the Cloud Run service identity's `roles/datastore.user` permission; until those are ready, the account can sign in but cloud chat sync will remain unavailable.

## Vertex AI setup

1. Enable the Vertex AI API (`aiplatform.googleapis.com`) in the `trux-ai` Google Cloud project.
2. Give the Cloud Run service identity the **Vertex AI User** role (`roles/aiplatform.user`).
3. Use Cloud Run Application Default Credentials. Do not download or commit a service-account JSON key.
4. Make sure billing, model access, and availability are enabled for the chosen model and location.

## Deploy to Cloud Run

From the repository root:

    gcloud run deploy trux-code --source . --region YOUR_CLOUD_RUN_REGION --allow-unauthenticated

No Firebase or Vertex AI environment variables are required by this implementation: those settings are read from `config/runtime-config.json`. Cloud Run supplies `PORT` automatically. The web app is public so Firebase sign-in can load in a browser; all account, chat-history, and model APIs are protected by a verified session cookie or supported Firebase ID token.

For local development, install dependencies and authenticate with Google Cloud Application Default Credentials:

    npm install
    npm start

Optional local server port: set `PORT` in your local shell. `.env.example` contains only that optional setting. Keep local `.env` files and service credentials out of Git.

## Main structure

- `config/runtime-config.json` — Google Cloud and Firebase app configuration, outside the static web root.
- `functions/api/chat.js` — token verification and streamed Vertex AI responses.
- `public/index.html` — responsive dark UI, Google/email sign-in, profile, model controls, local cache, and cloud-chat synchronization.
- `server.js` — Cloud Run HTTP server, Firebase client-config endpoint, session handling, account profiles, Firestore chat storage, and the explicit non-public config-path block.
- `Dockerfile` — production container image.

## Firebase authentication and session security

- Email/password accounts are created in Firebase Authentication. Passwords are handled by Firebase Auth and must never be copied into Firestore, cookies, localStorage, logs, or application-owned profile records.
- After sign-in, the server exchanges the Firebase ID token for a 14-day session cookie. On HTTPS deployments the cookie is `__Host-trux_code_session`, with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain` attribute.
- Firebase client auth is kept in memory only; the HttpOnly server cookie restores the account profile after a reload, without storing refresh tokens in localStorage. HTTPS uses the `__Host-trux_code_session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`) with a 14-day maximum lifetime. After expiry, the user must authenticate again. Session endpoints are same-origin protected, responses are not cached, and protected requests verify session cookies with revocation checks enabled.
- Cloud Run should use its attached runtime service account through Application Default Credentials. Do not create or commit a service-account JSON key. The runtime identity needs Firestore access (`roles/datastore.user`) and Firebase Authentication admin access for profile updates. Session restoration verifies the existing HttpOnly cookie directly and does **not** mint Firebase custom tokens or require `iam.serviceAccounts.signBlob` for that restoration path.
- Enable the Email/Password provider in Firebase Authentication and add the production app hostname to Firebase Authentication's authorized domains. Set `APP_ORIGIN` only when the app uses a different public origin; provide the origin without a trailing slash.
- The server cookie has a maximum lifetime of 14 days. A cookie that expires must be replaced after a fresh Firebase sign-in; the application does not store a Firebase refresh token in browser storage.
