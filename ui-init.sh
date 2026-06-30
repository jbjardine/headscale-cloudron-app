#!/bin/sh
set -eu

CONFIG_PATH="/app/data/config.yaml"
KEY_FILE="/app/data/ui_apikey"
UI_CONFIG="/run/headscale-ui/config.js"
APP_ORIGIN="${CLOUDRON_APP_ORIGIN:-http://localhost:8080}"
SOCKET_PATH="/run/headscale/headscale.sock"
HEADSCALE_API_URL="${HEADSCALE_API_URL:-http://127.0.0.1:8081}"
UI_APIKEY_EXPIRATION="${UI_APIKEY_EXPIRATION:-3650d}"

wait_for_api() {
  waited=0
  while [ "${waited}" -lt 30 ]; do
    if curl -fsS "${HEADSCALE_API_URL}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

api_key_is_valid() {
  candidate_key="$1"
  if [ -z "${candidate_key}" ]; then
    return 1
  fi

  waited=0
  while [ "${waited}" -lt 5 ]; do
    if curl -fsS \
      -H "Accept: application/json" \
      -H "Authorization: Bearer ${candidate_key}" \
      "${HEADSCALE_API_URL}/api/v1/user" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

create_api_key() {
  key_json="$(headscale --config "${CONFIG_PATH}" apikeys create --expiration "${UI_APIKEY_EXPIRATION}" --output json)"
  printf '%s' "${key_json}" | python3 -c 'import json,sys; v=json.load(sys.stdin); print(v["key"] if isinstance(v, dict) else v)'
}

max_wait=60
waited=0
while [ ! -S "${SOCKET_PATH}" ] && [ "${waited}" -lt "${max_wait}" ]; do
  sleep 1
  waited=$((waited + 1))
done

if [ ! -S "${SOCKET_PATH}" ]; then
  echo "Headscale socket not ready; skipping UI init" >&2
  exit 0
fi

if ! wait_for_api; then
  echo "Headscale API not ready; skipping UI init" >&2
  exit 0
fi

api_key="$(cat "${KEY_FILE}" 2>/dev/null || true)"
if ! api_key_is_valid "${api_key}"; then
  if [ -s "${KEY_FILE}" ]; then
    backup_path="${KEY_FILE}.invalid-$(date -u +%Y%m%d%H%M%S)"
    mv "${KEY_FILE}" "${backup_path}"
    chmod 600 "${backup_path}"
  fi

  api_key="$(create_api_key)"
  if ! api_key_is_valid "${api_key}"; then
    echo "New Headscale UI API key did not validate" >&2
    exit 1
  fi

  printf '%s\n' "${api_key}" > "${KEY_FILE}"
  chmod 600 "${KEY_FILE}"
fi

UI_API_URL="${APP_ORIGIN%/}/web"
export UI_API_URL
js_url="$(python3 -c 'import json,os; print(json.dumps(os.environ["UI_API_URL"]))')"

cat > "${UI_CONFIG}" <<EOF
(function () {
  var url = ${js_url};
  try {
    localStorage.setItem('headscaleURL', url);
    localStorage.removeItem('headscaleAPIKey');
  } catch (e) {
    console.warn('Headscale UI bootstrap failed', e);
  }
})();
EOF
