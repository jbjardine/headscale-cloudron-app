#!/bin/sh
set -eu

KEY_FILE="${HEADSCALE_UI_API_KEY_FILE:-/app/data/ui_apikey}"
max_wait="${HEADSCALE_UI_API_KEY_WAIT:-90}"
waited=0

while [ ! -s "${KEY_FILE}" ] && [ "${waited}" -lt "${max_wait}" ]; do
  sleep 1
  waited=$((waited + 1))
done

if [ ! -s "${KEY_FILE}" ]; then
  echo "Headscale UI API key not ready; refusing to start Caddy" >&2
  exit 1
fi

export HEADSCALE_UI_API_KEY
HEADSCALE_UI_API_KEY="$(cat "${KEY_FILE}")"

exec /usr/sbin/caddy run --config /app/code/Caddyfile --adapter caddyfile
