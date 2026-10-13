# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim
ARG APP_VERSION=1.1.0-rc.3
ARG APP_COMMIT=unknown
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    WEB_DATA_DIR=/data \
    MRS_VERSION=${APP_VERSION} \
    MRS_COMMIT=${APP_COMMIT}
LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_COMMIT}" \
      org.opencontainers.image.title="microsoft-rewards-web-admin"
WORKDIR /opt/mrs-admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown 1000:1000 /data \
    && chmod 700 /data
COPY admin/src ./src
COPY admin/public ./public
USER 1000:1000
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
