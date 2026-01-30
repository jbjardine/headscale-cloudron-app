#!/bin/sh
set -eu

APP_ORIGIN="${CLOUDRON_APP_ORIGIN:-http://localhost:8080}"
CONFIG_PATH="${HEADSCALE_CONFIG:-/app/data/config.yaml}"
DB_PATH="/app/data/db.sqlite"
ACL_PATH="/app/data/acl.hujson"
NOISE_KEY_PATH="/app/data/noise_private.key"
DERP_KEY_PATH="/app/data/derp_server_private.key"
UNIX_SOCKET="/run/headscale/headscale.sock"

mkdir -p /app/data /run/headscale

if [ ! -f "${ACL_PATH}" ]; then
  cat > "${ACL_PATH}" <<'EOF'
{
  "acls": [
    {
      "action": "accept",
      "src": ["*"],
      "dst": ["*:*"]
    }
  ]
}
EOF
fi

if [ ! -f "${DB_PATH}" ]; then
  touch "${DB_PATH}"
fi

if [ ! -f "${CONFIG_PATH}" ] && [ "${CONFIG_PATH}" = "/app/data/config.yaml" ]; then
  cat > "${CONFIG_PATH}" <<EOF
server_url: ${APP_ORIGIN}
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false

noise:
  private_key_path: ${NOISE_KEY_PATH}

prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential

derp:
  server:
    enabled: false
    region_id: 999
    region_code: "headscale"
    region_name: "Headscale Embedded DERP"
    verify_clients: true
    stun_listen_addr: "0.0.0.0:3478"
    private_key_path: ${DERP_KEY_PATH}
    automatically_add_embedded_derp_region: true
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  paths: []
  auto_update_enabled: true
  update_frequency: "3h"

disable_check_updates: false
ephemeral_node_inactivity_timeout: "30m"

database:
  type: sqlite
  debug: false
  gorm:
    prepare_stmt: true
    parameterized_queries: true
    skip_err_record_not_found: true
    slow_threshold: 1000
  sqlite:
    path: ${DB_PATH}
    write_ahead_log: true
    wal_autocheckpoint: 1000

log:
  level: info
  format: text

policy:
  mode: file
  path: ${ACL_PATH}

dns:
  magic_dns: false
  base_domain: ""
  override_local_dns: false
  nameservers:
    global: []
  search_domains: []
  extra_records: []

unix_socket: ${UNIX_SOCKET}
unix_socket_permission: "0770"

logtail:
  enabled: false

randomize_client_port: false
EOF
fi

RUN_USER="root"
if id -u cloudron >/dev/null 2>&1; then
  RUN_USER="cloudron"
elif id -u headscale >/dev/null 2>&1; then
  RUN_USER="headscale"
fi

chown -R "${RUN_USER}" /app/data /run/headscale || true

if [ "${RUN_USER}" = "root" ]; then
  exec headscale serve --config "${CONFIG_PATH}"
fi

if command -v su-exec >/dev/null 2>&1; then
  exec su-exec "${RUN_USER}" headscale serve --config "${CONFIG_PATH}"
fi

if command -v gosu >/dev/null 2>&1; then
  exec gosu "${RUN_USER}" headscale serve --config "${CONFIG_PATH}"
fi

exec headscale serve --config "${CONFIG_PATH}"
