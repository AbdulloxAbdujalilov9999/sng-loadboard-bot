# syntax=docker/dockerfile:1
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
USER node
# No HTTP server to probe - this is a background worker (Telegram long-polling + a Postgres LISTEN
# connection). A platform healthcheck should just watch that the process stays up.
CMD ["node", "src/index.js"]
