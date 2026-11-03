# TruX Code

A Claude-style coding workspace for Cloud Run, with official MCP connectors, long-term memory, and replies that keep running when you go offline. The browser UI lives in `public/index.html`; the authenticated, streaming Vertex AI endpoint lives in `functions/api/chat.js`.

## Features

- Claude-inspired layout: collapsible sidebar, centered welcome with the composer beneath it, rounded composer with model and Low / Medium / High thinking pickers, and light, dark, or system themes with a custom accent color. Styles live in `public/styles.css`.
- Connectors: official MCP servers (GitHub, Google Workspace, Google Developer Knowledge) connected from the Connectors page. The model gets their tools in chats; each connector can be switched on or off and is read-only until you allow changes.
- Memory: the model decides what is worth remembering about you and saves short notes that are used in later chats. The Memory page lists them and lets you delete any or all.
- Background replies: a reply is a saved job on the server. Going offline, closing the tab or reloading does not cancel it; the finished answer is there when you come back.
- Activity sheet: the thinking bar opens a half-page sheet showing what the assistant is doing (thinking summary, tool use, writing). Scroll or drag it up for the full page.
- Firebase Authentication with Google sign-in and email/password accounts. The browser SDK is bundled into the Cloud Run image and served locally; sign-in does not fetch Firebase modules from `gstatic.com` at runtime.
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
- Never put service-account private keys, passwords, connector keys, or other genuine secrets in this file. Use the Cloud Run service identity for Google Cloud access and Secret Manager for actual secrets.

The Firebase project ID and Google Cloud project ID must both be trux-ai. This ensures a Google or email/password account created in TruX-AI can sign into TruX-Code with the same Firebase UID. The Firebase Authentication provider must be enabled and trux-code.trux.website must be listed under Firebase Authentication → Settings → Authorized domains.

## Connectors, memory and background replies

### Connectors (MCP)

TruX Code is an MCP client. The server list is fixed in `functions/mcp/catalog.js`; users cannot point it at an arbitrary URL. Every endpoint is a vendor-hosted remote server over Streamable HTTP:

| Connector | Server | Sign-in |
| --- | --- | --- |
| GitHub | `https://api.githubcopilot.com/mcp/` | Personal access token (fine-grained) |
| Google Developer Knowledge | `https://developerknowledge.googleapis.com/mcp` | API key (per user, or one shared key) |
| Gmail, Drive, Docs, Sheets, Slides, Calendar, People | `https://<product>mcp.googleapis.com/mcp/v1` | Google sign-in (OAuth) |

Not included, on purpose: servers that run as a local process (filesystem, git, Chrome DevTools, Flutter, the Firebase CLI) would operate on the Cloud Run container's disk, not on your project. The Google Cloud product servers (BigQuery, Firestore, Cloud Run, ...) each need their own OAuth scopes and project IAM setup; add them to the catalog once you have decided the scopes for your project.

Setup:

1. Create the encryption key that protects saved credentials, and give the Cloud Run service account access:

        openssl rand -base64 32 | gcloud secrets create MCP_ENCRYPTION_KEY --data-file=-
        gcloud secrets add-iam-policy-binding MCP_ENCRYPTION_KEY \
          --member="serviceAccount:YOUR_RUN_SERVICE_ACCOUNT" --role=roles/secretmanager.secretAccessor

2. Google Workspace connectors need your own OAuth client (Google's servers do not support dynamic client registration). In Google Auth Platform create a **Web application** client with the AI-agent option selected, add `https://trux-code.trux.website/connectors/google/callback` as an authorized redirect URI, enable the Workspace APIs and their `*mcp.googleapis.com` services for the project, and join the Google Workspace Developer Preview Program. Store the client secret in Secret Manager.
3. Expose the secrets to the service:

        gcloud run services update trux-code --region YOUR_REGION \
          --update-secrets MCP_ENCRYPTION_KEY=MCP_ENCRYPTION_KEY:latest,GOOGLE_OAUTH_CLIENT_SECRET=GOOGLE_OAUTH_CLIENT_SECRET:latest \
          --update-env-vars GOOGLE_OAUTH_CLIENT_ID=YOUR_CLIENT_ID

How it is kept safe:

- Credentials are encrypted with AES-256-GCM (key derived per user and connector from `MCP_ENCRYPTION_KEY`) before they reach Firestore, and are never sent to the browser. A pasted token is checked against the real server before it is saved.
- Tools that can change things are hidden from the model unless "Allow changes" is on for that connector. This is enforced from each tool's MCP `readOnlyHint`, not just requested in the prompt.
- Tool output is passed to the model labelled as untrusted data, and the system prompt tells it never to follow instructions found inside it.
- Google sign-in uses authorization code + PKCE with a single-use `state` that is bound to the signed-in user.

### Memory

The model has two tools, `memory_save` and `memory_forget`, and decides when to use them. Notes live at `users/{uid}/memories/{id}` (kept to 120, near-duplicates update the existing note) and the most relevant ones are added to each request. A save must quote the user's own words as evidence, so text that only came from a web page, file or connector cannot become a standing instruction, and anything that looks like a key, token or card number is refused. Incognito chats and the "Use and save memory" switch turn it off.

### Background replies

A chat request creates a job document at `users/{uid}/jobs/{key}` (keyed by a client request id, so a retry attaches to the same reply instead of starting another). While the model writes, text and steps are saved about once a second. The browser follows the stream live; if the connection drops it polls `GET /api/chat/jobs/:requestId`, and after a reload it settles the reply it was waiting for. When the reply ends the server also writes the finished answer into the chat itself.

Two deployment settings are required for this to work:

1. Keep CPU allocated after the browser disconnects (otherwise Cloud Run pauses the instance and the reply stalls), allow long requests, and keep one instance warm so an idle service is not scaled to zero while a reply is still being written for an offline browser:

        gcloud run services update trux-code --region YOUR_REGION \
          --no-cpu-throttling --timeout=900 --min-instances=1

2. Let Firestore delete old jobs and sign-in states on its own with TTL policies on the `expireAt` field:

        gcloud firestore fields ttls update expireAt --collection-group=jobs --enable-ttl --async
        gcloud firestore fields ttls update expireAt --collection-group=oauthStates --enable-ttl --async

Limits worth knowing: a reply is capped at 10 minutes, a Cloud Run instance that is shut down mid-reply marks it interrupted (the browser then offers a retry), and a message typed while offline is sent when the connection returns, but only while that tab stays open. Incognito replies are not saved anywhere, so they are not resumable.

### Chat storage

Chats are stored in Cloud Firestore (not the Realtime Database): many small ordered documents listed by recency and loaded one at a time suit Firestore's indexed queries and per-document billing. Each chat keeps a short hash per message, so saving writes only the messages that changed and reads nothing; the sidebar loads titles only and a chat's messages are fetched when it is opened.

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
- `functions/api/chat.js` — token verification, the model/tool-calling loop, and the job status and stop endpoints.
- `functions/jobs.js` — background reply jobs. `functions/store.js` — chat storage. `functions/memory.js` — memory.
- `functions/mcp/` — connector catalog, encrypted credential vault, Google OAuth, and the MCP client manager.
- `public/connectors.js`, `public/memory.js`, `public/offline.js`, `public/sw.js`, `public/trux-live.css` — connector and memory screens, connection banner, offline app shell, and the activity sheet styles.
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
