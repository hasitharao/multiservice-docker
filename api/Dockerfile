# ---- Stage 1: install production dependencies only -------------------------
ARG BASE_IMAGE=multiservice/api-base:1.0
FROM ${BASE_IMAGE} AS deps

# Copy ONLY the dependency manifests first. Docker caches this layer, so
# `npm ci` re-runs only when package*.json changes, not on every code edit.
COPY package.json package-lock.json ./

# BuildKit cache mount: npm's download cache survives between builds.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---- Stage 2: the final, small runtime image --------------------------------
FROM ${BASE_IMAGE} AS runtime

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Never run as root
USER node
EXPOSE 3000

# Node 24 has fetch built in, so no curl/wget is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
