FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY functions ./functions
COPY public ./public

EXPOSE 8080
CMD ["node", "server.js"]
