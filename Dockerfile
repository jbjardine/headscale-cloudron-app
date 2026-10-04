# syntax=docker/dockerfile:1
FROM golang:1.26.6-alpine AS gateway-build
WORKDIR /src
COPY gateway/go.mod gateway/go.sum ./
RUN --mount=type=secret,id=proxy_ca --mount=type=cache,target=/go/pkg/mod \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    go mod download
COPY gateway/ ./
RUN --mount=type=secret,id=proxy_ca --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    go test ./... && CGO_ENABLED=0 go build -trimpath -o /out/headscale-gateway .

FROM alpine:3.24

ENV HEADSCALE_VERSION=0.29.4 \
    HEADSCALE_SHA256=212ed0a884c0d3541e094c4bebbe94397df6f4e01bd3d7f059c520cb55e0d757 \
    HEADSCALE_UI_VERSION=2026.03.17 \
    HEADSCALE_UI_SHA256=e959dde83569233a8643917e5c58f596b433709556b86f9e998c729d01a6cb29

RUN --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apk add --no-cache bash ca-certificates curl python3 py3-yaml su-exec unzip caddy supervisor sqlite; \
    adduser -S -H -s /sbin/nologin cloudron; \
    mkdir -p /app/code/ui

RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    curl -fsSL -o /usr/local/bin/headscale \
    "https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/headscale_${HEADSCALE_VERSION}_linux_amd64" \
    && echo "${HEADSCALE_SHA256}  /usr/local/bin/headscale" | sha256sum -c - \
    && chmod +x /usr/local/bin/headscale

RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    curl -fsSL -o /tmp/headscale-ui.zip \
    "https://github.com/gurucomputing/headscale-ui/releases/download/${HEADSCALE_UI_VERSION}/headscale-ui.zip" \
    && echo "${HEADSCALE_UI_SHA256}  /tmp/headscale-ui.zip" | sha256sum -c - \
    && unzip /tmp/headscale-ui.zip -d /app/code/ui \
    && rm -f /tmp/headscale-ui.zip \
    && for f in /app/code/ui/web/*.html; do \
        sed -i 's#</head>#  <title>Headscale</title>\n  <script src="/web/config.js"></script>\n</head>#' "$f"; \
      done

COPY devices-sort.js /app/code/ui/web/devices-sort.js
RUN sed -i 's#</head>#  <script src="/web/devices-sort.js" defer></script>\n</head>#' /app/code/ui/web/devices.html

COPY web/ /app/code/ui/web/
RUN for f in /app/code/ui/web/*.html; do \
      if ! grep -q 'package-ui.js' "$f"; then \
        sed -i 's#</head>#  <link rel="stylesheet" href="/web/package-ui.css">\n  <script src="/web/package-ui.js" defer></script>\n</head>#' "$f"; \
      fi; \
    done

COPY Caddyfile /app/code/Caddyfile
COPY supervisord.conf /app/code/supervisord.conf
COPY ui-api-proxy.py /app/code/ui-api-proxy.py
COPY gateway_settings.py /app/code/gateway_settings.py
COPY derp_config.py /app/code/derp_config.py
COPY --from=gateway-build /out/headscale-gateway /usr/local/bin/headscale-gateway
COPY gateway/TAILSCALE-LICENSE /app/code/licenses/TAILSCALE-LICENSE
COPY ui-init.sh /app/code/ui-init.sh
COPY caddy-start.sh /app/code/caddy-start.sh
COPY start.sh /app/code/start.sh
RUN sed -i 's/\r$//' /app/code/start.sh /app/code/ui-init.sh /app/code/ui-api-proxy.py /app/code/ui/web/devices-sort.js /app/code/caddy-start.sh \
    && chmod -R a+rX /app/code \
    && chmod +x /app/code/start.sh /app/code/ui-init.sh /app/code/ui-api-proxy.py /app/code/caddy-start.sh

EXPOSE 8080
EXPOSE 3478/udp

CMD ["/app/code/start.sh"]
