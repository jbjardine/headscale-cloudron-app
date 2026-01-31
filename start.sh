#!/bin/sh
set -eu

APP_ORIGIN="${CLOUDRON_APP_ORIGIN:-http://localhost:8080}"
CONFIG_PATH="${HEADSCALE_CONFIG:-/app/data/config.yaml}"
DB_PATH="/app/data/db.sqlite"
ACL_PATH="/app/data/acl.hujson"
NOISE_KEY_PATH="/app/data/noise_private.key"
DERP_KEY_PATH="/app/data/derp_server_private.key"
UNIX_SOCKET="/run/headscale/headscale.sock"
HEADSCALE_LISTEN_ADDR="127.0.0.1:8081"
HEADSCALE_GRPC_ADDR="127.0.0.1:50443"
CADDY_DATA_DIR="/run/caddy/data"
CADDY_CONFIG_DIR="/run/caddy/config"
UI_RUNTIME_DIR="/run/headscale-ui"

mkdir -p /app/data /run/headscale "${CADDY_DATA_DIR}" "${CADDY_CONFIG_DIR}" "${UI_RUNTIME_DIR}"

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
listen_addr: ${HEADSCALE_LISTEN_ADDR}
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: ${HEADSCALE_GRPC_ADDR}
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

if [ -f "${CONFIG_PATH}" ]; then
  if grep -qE '^listen_addr:\s*.*:8080\s*$' "${CONFIG_PATH}"; then
    sed -i "s#^listen_addr:.*#listen_addr: ${HEADSCALE_LISTEN_ADDR}#g" "${CONFIG_PATH}"
  fi
  if grep -qE '^grpc_listen_addr:\s*.*:50443\s*$' "${CONFIG_PATH}"; then
    sed -i "s#^grpc_listen_addr:.*#grpc_listen_addr: ${HEADSCALE_GRPC_ADDR}#g" "${CONFIG_PATH}"
  fi
fi

RUN_USER="root"
if id -u cloudron >/dev/null 2>&1; then
  RUN_USER="cloudron"
elif id -u headscale >/dev/null 2>&1; then
  RUN_USER="headscale"
fi

chown -R "${RUN_USER}" /app/data /run/headscale /run/caddy "${UI_RUNTIME_DIR}" || true

export XDG_DATA_HOME="${CADDY_DATA_DIR}"
export XDG_CONFIG_HOME="${CADDY_CONFIG_DIR}"

exec /usr/bin/supervisord -c /app/code/supervisord.conf
