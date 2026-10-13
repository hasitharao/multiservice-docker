# Custom base image for the web frontend: a non-root nginx (listens on 8080)
# preconfigured for single-page apps (SPA fallback, gzip, caching, security headers).
FROM nginxinc/nginx-unprivileged:1.28-alpine

LABEL org.opencontainers.image.title="web-base" \
      org.opencontainers.image.description="Non-root nginx tuned for serving a React SPA"

COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY default.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
