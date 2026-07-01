# Changelog

## 0.28.0-12 - 2026-07-01

- Materialize missing Headscale node tag and route arrays as empty arrays for the bundled UI.

## 0.28.0-11 - 2026-07-01

- Normalize Headscale node API responses for the bundled UI so device names and last-seen values render correctly.
- Keep Headscale API key mutation blocking in both Caddy and the server-side UI API proxy.

## 0.28.0-10 - 2026-07-01

- Keep the Headscale UI API token server-side behind the `/web/api/*` proxy route.
- Replace the first-run wildcard ACL with a deny-by-default policy.
- Migrate the exact generated wildcard ACL to deny-by-default on upgrade.
- Verify downloaded Headscale and Headscale UI artifacts with pinned SHA256 hashes.
- Block browser-side Headscale API key mutations while allowing read-only key metadata checks.
