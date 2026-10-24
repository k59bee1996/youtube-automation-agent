# syntax=docker/dockerfile:1
# Node 20 satisfies the application's Node.js >=18 requirement and provides a
# glibc-based Linux environment compatible with Sharp and sqlite3 prebuilds.
FROM node:20-bookworm-slim

ARG DARKZSEO_REF=a6270c512bb338e8251c363656f93891a9afa671

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DARKZSEO_PYTHON=/opt/darkzseo-venv/bin/python \
    DARKZSEO_PATH=/opt/darkzseo/darkzseo.py \
    npm_config_update_notifier=false

WORKDIR /app

# FFmpeg is used for media assembly. Playwright installs the Chromium runtime
# dependencies below, matching the browser version locked in package-lock.json.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# DarkzSEO is an optional, advisory audit in the application. Bake its Python
# source and isolated dependencies into the image so Compose deployments do not
# rely on a host Python installation or a sibling checkout.
RUN git init /opt/darkzseo \
    && git -C /opt/darkzseo remote add origin https://github.com/darkzOGx/darkzseo.git \
    && git -C /opt/darkzseo fetch --depth 1 origin "$DARKZSEO_REF" \
    && git -C /opt/darkzseo checkout --detach FETCH_HEAD \
    && python3 -m venv /opt/darkzseo-venv \
    && /opt/darkzseo-venv/bin/pip install --no-cache-dir -r /opt/darkzseo/requirements.txt \
    && /opt/darkzseo-venv/bin/python /opt/darkzseo/darkzseo.py --help > /dev/null

# Keep dependency installation separately cached from application source code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY --chown=node:node . .

# The application creates subdirectories as needed; these roots must be
# writable when the container runs as the non-root node user.
RUN mkdir -p /app/data /app/uploads /app/logs /app/reports /app/temp \
    && chown -R node:node /app/data /app/uploads /app/logs /app/reports /app/temp /app/config

USER node

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:3456/health',res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1)});"

CMD ["npm", "start"]
