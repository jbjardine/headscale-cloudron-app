FROM headscale/headscale:0.27.1

RUN set -eux; \
    if command -v apk >/dev/null 2>&1; then \
        apk add --no-cache su-exec; \
    elif command -v apt-get >/dev/null 2>&1; then \
        apt-get update; \
        apt-get install -y --no-install-recommends gosu; \
        rm -rf /var/lib/apt/lists/*; \
    else \
        echo "No supported package manager found for gosu/su-exec" >&2; \
        exit 1; \
    fi; \
    if ! id -u cloudron >/dev/null 2>&1; then \
        if command -v adduser >/dev/null 2>&1; then \
            adduser -S -H -s /sbin/nologin cloudron 2>/dev/null || \
            adduser --system --home /nonexistent --shell /usr/sbin/nologin --group cloudron; \
        elif command -v useradd >/dev/null 2>&1; then \
            useradd --system --home /nonexistent --shell /usr/sbin/nologin cloudron; \
        fi; \
    fi; \
    mkdir -p /app/code

COPY start.sh /app/code/start.sh
RUN chmod +x /app/code/start.sh

EXPOSE 8080
EXPOSE 3478/udp

CMD ["/app/code/start.sh"]
