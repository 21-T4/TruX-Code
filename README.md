# TruX Code

A minimal dark coding workspace for Cloud Run. The browser UI lives in `public/index.html`; the authenticated, streaming Vertex AI endpoint lives in `functions/api/chat.js`.

## Features

- Dark workspace with a sidebar, centered AI-generated welcome, recent chats, model selector, and Low / Medium / High thinking.
- Firebase Authentication with Google sign-in and email/password accounts.
- The backend verifies the HttpOnly TruX session cookie before chat, profile, and history requests (and accepts a Firebase ID token for compatible clients).
- Vertex AI is called directly through the Google Gen AI SDK and Cloud Run Application Default Credentials. No Gemini API key or downloaded service-account key is used.
- Google sign-in automatically creates or returns a Firebase Authentication account with a unique UID; the same Firebase project can provide the shared TruX account identity.
- Firebase Authentication is the canonical TruX account. The first Google sign-in creates a unique Auth UID; later sign-ins reuse that same account. The server syncs a Firestore profile at `users/{uid}` when Firestore is available, and cloud chats live at `users/{uid}/chats/{chatId}` with ordered message documents. The browser also keeps an account-specific local cache.
- Chat, profile, and session API routes derive the owner from the verified Firebase session, never from a client-supplied UID.
- Add your logo at `public/logo.png`.

## Environment file

TruX Code uses the same Firebase project and account identity as TruX-AI. Configuration is loaded from the .env file at process startup by Node.js 22; Cloud Run does not need separate Firebase environment variables configured in the service.

- .env.example is the checked-in environment file template and contains only public Firebase web-app settings plus the Google Cloud project and Vertex AI location.
- The Dockerfile copies .env.example to .env inside the image. For local development, run cp .env.example .env and then npm start.
- Firebase web configuration is public client configuration. It is returned by /api/config for the browser to initialize Firebase. It is not a service-account credential.
- Never put service-account private keys, passwords, Composio keys, or other genuine secrets in this file. Use the Cloud Run service identity for Google Cloud access and Secret Manager for actual secrets.

The Firebase project ID and Google Cloud project ID must both be trux-ai. This ensures a Google or email/password account created in TruX-AI can sign into TruX-Code with the same Firebase UID. The Firebase Authentication provider must be enabled and trux-code.trux.website must be listed under Firebase Authentication → Settings → Authorized domains.

## Model choices

- Gemini 4 Argon — default model ID: `gemini-4-argon`.
- Gemini 3.1 Pro — `gemini-3.1-pro-preview`.
- Gemini 3.8 Flash — `gemini-3.8-flash`.

The implementation does not guess a model ID for “Gemini 3.4 Argon,” which I could not verify. Model availability depends on the project's Vertex AI access and the selected location.

## Firebase and Firestore setup

1. In Firebase Console, open Authentication → Sign-in method and enable **Google** and **Email/Password**. A first Google sign-in automatically creates the Firebase Auth account; TruX Code then asks the user to link a password credential to that same UID. Firebase Authentication securely manages the password; TruX Code never stores plaintext passwords.
2. Add `trux-code.trux.website` to Authentication → Settings → Authorized domains. Confirm the same Firebase project (`trux-ai`) is used by the TruX app whose account identity should be shared.
3. In the Google Cloud project `trux-ai`, create/enable the **default Cloud Firestore database** in Native mode and choose the appropriate region. The server uses the Admin SDK, so browser Firestore rules do not authorize these server requests; the server derives each user UID from the validated session cookie.
4. Grant the Cloud Run service identity `roles/datastore.user` for Firestore read/write access and `roles/firebaseauth.admin` (or a narrower equivalent) for the account profile update endpoint. Keep those roles scoped to the service identity.
5. Verify that `.env.example` contains the intended Firebase web app settings. Configure appropriate API restrictions for the Firebase browser API key and secure any other Firebase data with the relevant Security Rules; do not rely on hiding a Firebase web API key.

Firebase Authentication remains the source of account identities and credentials, but TruX's persistent HttpOnly session is stored in Firestore. Therefore, Firestore must be enabled and the Cloud Run service identity must have `roles/datastore.user` for a successful persistent sign-in as well as cloud chat synchronization. Profile-document sync at `users/{uid}` remains best-effort; a temporary profile write failure does not block a session when the session store itself is available.

## Vertex AI setup

1. Enable the Vertex AI API (`aiplatform.googleapis.com`) in the `trux-ai` Google Cloud project.
2. Give the Cloud Run service identity the **Vertex AI User** role (`roles/aiplatform.user`).
3. Use Cloud Run Application Default Credentials. Do not download or commit a service-account JSON key.
4. Make sure billing, model access, and availability are enabled for the chosen model and location.

## Deploy to Cloud Run

From the repository root:

    gcloud run deploy trux-code --source . --region YOUR_CLOUD_RUN_REGION --allow-unauthenticated

The Docker image loads Firebase and Vertex AI settings from `.env`, copied from `.env.example` during the image build. Do not add Firebase variables separately to the Cloud Run service configuration. Cloud Run supplies `PORT` automatically. The web app is public so Firebase sign-in can load in a browser; all account, chat-history, and model APIs are protected by a verified session cookie or supported Firebase ID token.

For local development, install dependencies and authenticate with Google Cloud Application Default Credentials:

    npm install
    npm start

For local development, copy `.env.example` to `.env`; Node.js loads it when `npm start` runs. The real `.env` remains ignored by Git. Keep service-account credentials and other secrets out of both files.

## Main structure

- `.env.example` — public Firebase web configuration, Google Cloud project, and Vertex AI location, loaded into the server process at startup.
- `functions/api/chat.js` — token verification and streamed Vertex AI responses.
- `public/index.html` — responsive dark UI, Google/email sign-in, profile, model controls, local cache, and cloud-chat synchronization.
- `server.js` — Cloud Run HTTP server, Firebase client-config endpoint, session handling, account profiles, and Firestore chat storage.
- `Dockerfile` — production container image.

## Firebase authentication and session security

- Google and email/password are linked sign-in methods on one Firebase Authentication UID. A first-time Google sign-in creates the account, then TruX Code asks the user to add a password to that same account. Firebase Auth stores and verifies the password; plaintext passwords are never written to Firestore, cookies, localStorage, logs, or TruX profile records.
- After Firebase verifies a sign-in, the server issues a random 400-day persistent `__Host-trux_code_session` cookie on HTTPS. It is `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and has no `Domain` attribute. This is an opaque TruX session token, not a Firebase JWT session cookie; Firebase's own session-cookie API is limited to 14 days.
- Firestore collection `truxCodeSessions` stores the session UID, expiry, and a SHA-256 hash of the random cookie secret. The raw secret is only in the HttpOnly browser cookie. Returning to the app renews the 400-day expiry, so an actively used account is not forced to sign in every 14 days. Signing out deletes the server-side session record and clears the cookie. Disabled accounts and sessions invalidated by Firebase token revocation are rejected.
- Firebase client auth remains in memory; the HttpOnly server cookie restores the account profile after a reload without putting Firebase refresh tokens in localStorage. Session endpoints are same-origin protected and responses are not cached.
- Cloud Run should use its attached runtime service account through Application Default Credentials. Do not create or commit a service-account JSON key. The runtime identity needs Firestore access (`roles/datastore.user`) and Firebase Authentication admin access to verify account status and update profiles. Session restore does not mint Firebase custom tokens or require `iam.serviceAccounts.signBlob` for custom-token minting.
- Enable both Google and Email/Password providers in Firebase Authentication and add `trux-code.trux.website` to authorized domains. Set `APP_ORIGIN` only when the app uses a different public origin; provide the origin without a trailing slash.
