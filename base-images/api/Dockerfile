# Custom base image for the API service.
# Built once (tagged multiservice/api-base:1.0) and reused by api/Dockerfile.
# Anything every Node service in a company would need goes here.
FROM node:24-alpine

LABEL org.opencontainers.image.title="api-base" \
      org.opencontainers.image.description="Node.js base image with tini and sane defaults"

# tini = tiny init process. It forwards signals (so `docker stop` shuts the app
# down cleanly) and reaps zombie processes.
RUN apk add --no-cache tini \
 && mkdir -p /app \
 && chown node:node /app

# Production defaults + quieter, faster npm
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app
ENTRYPOINT ["/sbin/tini", "--"]
