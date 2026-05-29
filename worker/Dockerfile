# RemixSafe video worker
FROM node:20-alpine

# ffmpeg is the heart of the worker
RUN apk add --no-cache ffmpeg ca-certificates tini

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy app code
COPY . .

# Fly.io / generic env
ENV NODE_ENV=production
ENV WORK_DIR=/tmp/remixsafe

# tini reaps zombie ffmpeg processes cleanly
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","index.js"]
