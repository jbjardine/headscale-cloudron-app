FROM alpine:3.19

ENV HEADSCALE_VERSION=0.27.1 \
    HEADSCALE_UI_VERSION=2025.08.23

RUN set -eux; \
    apk add --no-cache ca-certificates curl su-exec unzip caddy supervisor sqlite; \
    adduser -S -H -s /sbin/nologin cloudron; \
    mkdir -p /app/code/ui

RUN curl -fsSL -o /usr/local/bin/headscale \
    "https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/headscale_${HEADSCALE_VERSION}_linux_amd64" \
    && chmod +x /usr/local/bin/headscale

RUN curl -fsSL -o /tmp/headscale-ui.zip \
    "https://github.com/gurucomputing/headscale-ui/releases/download/${HEADSCALE_UI_VERSION}/headscale-ui.zip" \
    && unzip /tmp/headscale-ui.zip -d /app/code/ui \
    && rm -f /tmp/headscale-ui.zip

COPY Caddyfile /app/code/Caddyfile
COPY supervisord.conf /app/code/supervisord.conf
COPY start.sh /app/code/start.sh
RUN chmod +x /app/code/start.sh

EXPOSE 8080
EXPOSE 3478/udp

CMD ["/app/code/start.sh"]
