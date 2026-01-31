#!/bin/sh
set -eu

CONFIG_PATH="/app/data/config.yaml"
KEY_FILE="/app/data/ui_apikey"
UI_CONFIG="/run/headscale-ui/config.js"
APP_ORIGIN="${CLOUDRON_APP_ORIGIN:-http://localhost:8080}"
SOCKET_PATH="/run/headscale/headscale.sock"

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

if [ ! -f "${KEY_FILE}" ]; then
  key_json="$(headscale --config "${CONFIG_PATH}" apikeys create --output json)"
  api_key="$(printf '%s' "${key_json}" | python3 -c 'import json,sys; v=json.load(sys.stdin); print(v["key"] if isinstance(v, dict) else v)')"
  printf '%s\n' "${api_key}" > "${KEY_FILE}"
  chmod 600 "${KEY_FILE}"
fi

api_key="$(cat "${KEY_FILE}")"
export APP_ORIGIN
export API_KEY="${api_key}"
js_url="$(python3 -c 'import json,os; print(json.dumps(os.environ["APP_ORIGIN"]))')"
js_key="$(python3 -c 'import json,os; print(json.dumps(os.environ["API_KEY"]))')"

cat > "${UI_CONFIG}" <<EOF
(function () {
  var url = ${js_url};
  var key = ${js_key};
  try {
    localStorage.setItem('headscaleURL', url);
    localStorage.setItem('headscaleAPIKey', key);
  } catch (e) {
    console.warn('Headscale UI bootstrap failed', e);
  }
})();
EOF
