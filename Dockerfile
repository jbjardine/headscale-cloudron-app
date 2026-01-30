FROM alpine:3.19

ENV HEADSCALE_VERSION=0.27.1

RUN set -eux; \
    apk add --no-cache ca-certificates curl su-exec; \
    adduser -S -H -s /sbin/nologin cloudron

RUN curl -fsSL -o /usr/local/bin/headscale \
    "https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/headscale_${HEADSCALE_VERSION}_linux_amd64" \
    && chmod +x /usr/local/bin/headscale

COPY start.sh /app/code/start.sh
RUN chmod +x /app/code/start.sh

EXPOSE 8080
EXPOSE 3478/udp

CMD ["/app/code/start.sh"]
