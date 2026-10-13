# ---- Stage 1: install ALL dependencies (dev deps are needed to build) ------
ARG NODE_IMAGE=node:24-alpine
ARG WEB_BASE_IMAGE=multiservice/web-base:1.0

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# Manifests first -> this layer is cached until package*.json changes
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---- Stage 2: build the static site ----------------------------------------
FROM deps AS build
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build
# Result: /app/dist (a few hundred KB of static files)

# ---- Stage 3: final image = custom nginx base + the built files only --------
# Node, node_modules and the source code are NOT in this image.
FROM ${WEB_BASE_IMAGE} AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
