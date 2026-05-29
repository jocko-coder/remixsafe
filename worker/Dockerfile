FROM node:20-slim

# Install ffmpeg and minimal deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install node deps first for layer caching
COPY worker/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy source
COPY worker/src ./src

ENV NODE_ENV=production

# tini reaps zombie ffmpeg processes
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
