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

EXPOSE 8080
CMD ["node", "server.js"]
