FROM alpine:3.24

ENV HEADSCALE_VERSION=0.29.2 \
    HEADSCALE_SHA256=858ef94bca9ecdfc742c24119c831e437e1b75691fdd5041be4059db1a38aac0 \
    HEADSCALE_UI_VERSION=2026.03.17 \
    HEADSCALE_UI_SHA256=e959dde83569233a8643917e5c58f596b433709556b86f9e998c729d01a6cb29

RUN set -eux; \
    apk add --no-cache bash ca-certificates curl python3 su-exec unzip caddy supervisor sqlite; \
    adduser -S -H -s /sbin/nologin cloudron; \
    mkdir -p /app/code/ui

RUN curl -fsSL -o /usr/local/bin/headscale \
    "https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/headscale_${HEADSCALE_VERSION}_linux_amd64" \
    && echo "${HEADSCALE_SHA256}  /usr/local/bin/headscale" | sha256sum -c - \
    && chmod +x /usr/local/bin/headscale

RUN curl -fsSL -o /tmp/headscale-ui.zip \
    "https://github.com/gurucomputing/headscale-ui/releases/download/${HEADSCALE_UI_VERSION}/headscale-ui.zip" \
    && echo "${HEADSCALE_UI_SHA256}  /tmp/headscale-ui.zip" | sha256sum -c - \
    && unzip /tmp/headscale-ui.zip -d /app/code/ui \
    && rm -f /tmp/headscale-ui.zip \
    && for f in /app/code/ui/web/*.html; do \
        sed -i 's#</head>#  <title>Headscale</title>\n  <script src="/web/config.js"></script>\n</head>#' "$f"; \
      done

COPY devices-sort.js /app/code/ui/web/devices-sort.js
RUN sed -i 's#</head>#  <script src="/web/devices-sort.js" defer></script>\n</head>#' /app/code/ui/web/devices.html

COPY Caddyfile /app/code/Caddyfile
COPY supervisord.conf /app/code/supervisord.conf
COPY ui-api-proxy.py /app/code/ui-api-proxy.py
COPY ui-init.sh /app/code/ui-init.sh
COPY caddy-start.sh /app/code/caddy-start.sh
COPY start.sh /app/code/start.sh
RUN sed -i 's/\r$//' /app/code/start.sh /app/code/ui-init.sh /app/code/ui-api-proxy.py /app/code/ui/web/devices-sort.js /app/code/caddy-start.sh \
    && chmod +x /app/code/start.sh /app/code/ui-init.sh /app/code/ui-api-proxy.py /app/code/caddy-start.sh

EXPOSE 8080
EXPOSE 3478/udp

CMD ["/app/code/start.sh"]
