# Standalone clustering worker. Build context is a staging dir holding
# this service's files plus the repo's lib/ (shared clustering code) —
# see cluster-service/README.md for the deploy command.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json worker.ts ./
COPY lib ./lib

ENV NODE_ENV=production
CMD ["npx", "tsx", "worker.ts"]
