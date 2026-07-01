# Changelog

## 0.29.2-1 - 2026-07-01

- Bump upstream Headscale to 0.29.2 and update generated default config to v0.29 options.
- Update bundled Headscale UI to 2026.03.17 and set base image to Alpine 3.24.

## 0.28.0-23 - 2026-07-01

- Make Device View user group headers fully clickable and avoid rebuilding grouped device cards when opening device details.

## 0.28.0-22 - 2026-07-01

- Make Device View user groups compact and aligned with the native User View list styling.

## 0.28.0-21 - 2026-07-01

- Normalize Headscale node user names so Device View user grouping works when the API exposes `username`, `display_name`, or `email` instead of `name`.

## 0.28.0-20 - 2026-07-01

- Polish Device View grouped user cards with lighter nested rows and clearer collapse controls.

## 0.28.0-19 - 2026-07-01

- Match Device View user grouping to the existing User View expandable card pattern.

## 0.28.0-18 - 2026-07-01

- Hide collapsed Device View user sections with inline display state so bundled UI card styles cannot keep devices visible.

## 0.28.0-17 - 2026-07-01

- Polish Device View user group headers so collapsed sections read as proper compact rows.

## 0.28.0-16 - 2026-07-01

- Make Device View user groups collapsible so each user's devices can be compacted under the user header.

## 0.28.0-15 - 2026-07-01

- Sort the proxied `/api/v1/node` list by Headscale user for the bundled UI.
- Add a browser-side Devices User toggle that groups visible device cards under user headers without handling API tokens.

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
