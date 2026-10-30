FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY functions ./functions
COPY .env.example ./.env
# Validate the environment file at build time. Firebase web settings are public
# client configuration; no service-account key is stored in the image.
RUN node --env-file=.env -e "const required=['FIREBASE_API_KEY','FIREBASE_AUTH_DOMAIN','FIREBASE_PROJECT_ID','FIREBASE_APP_ID','GOOGLE_CLOUD_PROJECT']; const missing=required.filter(k=>!process.env[k] || !process.env[k].trim()); if(missing.length) throw new Error('Missing settings in .env.example: '+missing.join(', ')); if(process.env.FIREBASE_PROJECT_ID !== process.env.GOOGLE_CLOUD_PROJECT) throw new Error('TruX Code and Firebase must use the same Google Cloud project.');"

COPY public ./public

# Bundle Firebase Auth into a same-origin browser asset. Runtime sign-in must not
# depend on downloading the Firebase SDK from gstatic.com on the user's device.
RUN npm run build:auth

# Catch browser-module syntax errors during image build, not after deployment.
RUN node -e "const fs=require('node:fs'); const html=fs.readFileSync('public/index.html','utf8'); const marker='<script type='; const tag=html.indexOf(marker); const start=html.indexOf('>',tag)+1; const end=html.indexOf('</script>',start); if(tag<0 || start<=0 || end<0 || html.slice(tag,start).indexOf('module')<0) throw new Error('Could not locate the TruX Code module script'); fs.writeFileSync('/tmp/trux-code-client.mjs',html.slice(start,end));" \
    && node --check /tmp/trux-code-client.mjs \
    && node --check server.js \
    && node --check functions/firebase-auth.js \
    && node --check functions/api/chat.js

EXPOSE 8080
CMD ["node", "--env-file=.env", "server.js"]
