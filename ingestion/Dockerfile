FROM node:20-alpine
WORKDIR /app

# Copy manifests first for layer caching.
COPY ingestion/package.json ingestion/package-lock.json* ./ingestion/
WORKDIR /app/ingestion
RUN npm install --omit=dev

# Copy source.
COPY ingestion/src ./src

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "src/server.js"]
