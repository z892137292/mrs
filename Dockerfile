# syntax=docker/dockerfile:1.7
###############################################################################
# Microsoft Rewards Custom image
#   upstream: TheNetsky/Microsoft-Rewards-Script (pinned commit, see upstream.env)
#   + patches/*.patch  (exit codes / run summary / account filter)
#   + docker/*         (lock, watchdog, retries, circuit breaker, logs, non-root)
###############################################################################
# bookworm is pinned explicitly: the Chromium runtime library names below
# (libflac12, libdav1d6, ...) are bookworm package names.
ARG NODE_IMAGE=node:24-bookworm-slim

###############################################################################
# Stage: source - fetch the pinned upstream commit and apply our patches
###############################################################################
FROM ${NODE_IMAGE} AS source
ARG UPSTREAM_REPO=https://github.com/TheNetsky/Microsoft-Rewards-Script.git
ARG UPSTREAM_REF=d0f07d74a0ed4dda127855d6e3dde98bf4c89d6e

# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init -q . \
    && git fetch -q --depth 1 "$UPSTREAM_REPO" "$UPSTREAM_REF" \
    && git checkout -q FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$UPSTREAM_REF"

COPY patches/ /patches/
RUN for p in /patches/*.patch; do git apply --check "$p" && git apply "$p" || exit 1; done \
    && rm -rf .git

###############################################################################
# Stage: builder - compile TypeScript, then keep production deps only
###############################################################################
FROM ${NODE_IMAGE} AS builder
WORKDIR /build
ENV PLAYWRIGHT_BROWSERS_PATH=0
COPY --from=source /src/package.json /src/package-lock.json /src/tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --from=source /src/ ./
RUN npm run build \
    && rm -rf node_modules \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

###############################################################################
# Stage: supercronic - verified static binary per architecture
###############################################################################
FROM scratch AS supercronic-amd64
ADD --chmod=755 --checksum=sha256:a53ae236602c7338aba3fbaff40bda6300eae3b9fedb8261eb06cfe3724430c1 \
    https://github.com/aptible/supercronic/releases/download/v0.2.49/supercronic-linux-amd64 /supercronic

FROM scratch AS supercronic-arm64
ADD --chmod=755 --checksum=sha256:02aa0cb229ba09050cba6638059dadb9eedc2276632ea43d6a57a2f8c1629dd5 \
    https://github.com/aptible/supercronic/releases/download/v0.2.49/supercronic-linux-arm64 /supercronic

# hadolint ignore=DL3006
FROM supercronic-${TARGETARCH} AS supercronic

###############################################################################
# Stage: runtime
###############################################################################
FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION=1.0.3-rc1
ARG UPSTREAM_REF=d0f07d74a0ed4dda127855d6e3dde98bf4c89d6e

ENV APP_DIR=/usr/src/microsoft-rewards-script \
    NODE_ENV=production \
    TZ=UTC \
    PLAYWRIGHT_BROWSERS_PATH=0 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PUID=1000 \
    PGID=1000

LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.title="microsoft-rewards-custom" \
      org.opencontainers.image.description="Self-maintained build of Microsoft-Rewards-Script with run lock, watchdog, bounded retries and persistent logs" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      io.github.mrs-custom.upstream-ref="${UPSTREAM_REF}"

# Chromium headless-shell runtime libraries (same set as upstream) + our tooling.
# tini: PID 1 / zombie reaping; procps: pgrep; jq: state files; util-linux (base): flock/setsid/setpriv
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini jq procps tzdata ca-certificates \
    libglib2.0-0 libdbus-1-3 libexpat1 libfontconfig1 libgtk-3-0 libnspr4 libnss3 \
    libasound2 libflac12 libatk1.0-0 libatspi2.0-0 libdrm2 libgbm1 libdav1d6 \
    libx11-6 libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
    libxi6 libxrandr2 libxrender1 libxss1 libxtst6 libdouble-conversion3 \
    fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-freefont-ttf fonts-droid-fallback \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR ${APP_DIR}

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json /build/package-lock.json ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=source  /src/config.example.json ./config.example.json

# Patchright's stealth-patched Chromium headless shell (installed into node_modules, world-readable).
RUN npx patchright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.npm

COPY --from=supercronic /supercronic /usr/local/bin/supercronic
COPY --chmod=644 docker/lib.sh                /usr/local/lib/rewards/lib.sh
COPY --chmod=644 docker/merge-summary.jq      /usr/local/lib/rewards/merge-summary.jq
COPY --chmod=755 docker/entrypoint.sh         /usr/local/bin/docker-entrypoint
COPY --chmod=755 docker/rewards-supervisor.sh /usr/local/bin/rewards-supervisor
COPY --chmod=755 docker/rewards-run.sh        /usr/local/bin/rewards-run
COPY --chmod=755 docker/rewards-ctl.sh        /usr/local/bin/rewards-ctl
COPY --chmod=755 docker/rewards-selftest.sh   /usr/local/bin/rewards-selftest
COPY --chmod=755 docker/healthcheck.sh        /usr/local/bin/rewards-healthcheck

# The app reads ./config.json; the real file lives in the persisted config/ volume.
RUN chmod 755 /usr/local/lib/rewards \
    && ln -s config/config.json config.json \
    && mkdir -p config sessions state logs diagnostics \
    && chown -R "${PUID}:${PGID}" config sessions state logs diagnostics

VOLUME ["/usr/src/microsoft-rewards-script/config", \
        "/usr/src/microsoft-rewards-script/sessions", \
        "/usr/src/microsoft-rewards-script/state", \
        "/usr/src/microsoft-rewards-script/logs", \
        "/usr/src/microsoft-rewards-script/diagnostics"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 CMD ["rewards-healthcheck"]

# Starts as root only to fix volume ownership, then drops to PUID:PGID (see entrypoint).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint"]
CMD ["supervisor"]
