FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY functions ./functions
COPY config ./config
# Fail the image build if the runtime file is missing or incomplete; do not deploy a broken sign-in page.
RUN node -e "const c = require('./config/runtime-config.json'); const f = c.firebase || {}; const required = ['apiKey', 'authDomain', 'projectId', 'appId']; const missing = required.filter(k => typeof f[k] !== 'string' || !f[k].trim()); if (!c.googleCloud || !c.googleCloud.projectId) throw new Error('Missing googleCloud.projectId in config/runtime-config.json'); if (missing.length) throw new Error('Missing Firebase config keys in config/runtime-config.json: ' + missing.join(', '))"
COPY public ./public

# Catch browser-module syntax errors during image build, not after deployment.
RUN node -e "const fs=require('node:fs'); const html=fs.readFileSync('public/index.html','utf8'); const marker='<script type='; const tag=html.indexOf(marker); const start=html.indexOf('>',tag)+1; const end=html.indexOf('</script>',start); if(tag<0 || start<=0 || end<0 || html.slice(tag,start).indexOf('module')<0) throw new Error('Could not locate the TruX Code module script'); fs.writeFileSync('/tmp/trux-code-client.mjs',html.slice(start,end));" \
    && node --check /tmp/trux-code-client.mjs \
    && node --check server.js \
    && node --check functions/firebase-auth.js \
    && node --check functions/api/chat.js

EXPOSE 8080
CMD ["node", "server.js"]
