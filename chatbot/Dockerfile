FROM node:20-alpine
WORKDIR /app

# The chatbot depends on the local SDK via file: protocol, so we need both.
COPY sdk ./sdk
COPY chatbot ./chatbot

# Install SDK dependencies first, then chatbot
WORKDIR /app/sdk
RUN npm install --omit=dev

WORKDIR /app/chatbot
RUN npm install --omit=dev

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "src/server.js"]
