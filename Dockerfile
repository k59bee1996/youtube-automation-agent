# syntax=docker/dockerfile:1
# Node 20 satisfies the application's Node.js >=18 requirement and provides a
# glibc-based Linux environment compatible with Sharp and sqlite3 prebuilds.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    npm_config_update_notifier=false

WORKDIR /app

# FFmpeg is used for media assembly. Playwright installs the Chromium runtime
# dependencies below, matching the browser version locked in package-lock.json.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Keep dependency installation separately cached from application source code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY --chown=node:node . .

# The application creates subdirectories as needed; these roots must be
# writable when the container runs as the non-root node user.
RUN mkdir -p /app/data /app/uploads /app/logs /app/reports \
    && chown -R node:node /app/data /app/uploads /app/logs /app/reports /app/config

USER node

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:3456/health',res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1)});"

CMD ["npm", "start"]
