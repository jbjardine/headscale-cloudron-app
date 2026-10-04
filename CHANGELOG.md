# Changelog

## 0.29.4-2 - 2026-10-04

- Show and copy complete enrollment keys once, including keys created in the upstream UI.
- Correct Headscale 0.29 user-key filtering and expire keys by their IDs instead of reporting a no-op success.
- Add responsive enrollment and gateway pages with clear expiry and registration options.
- Add an optional official Tailscale-to-Headscale TCP gateway with selected nodes/ports, source restrictions, connection/bandwidth limits and persistent isolated identities.
- Keep gateway keys private and the gateway disabled by default; remove the unused NET_ADMIN capability.
- Update golang.org/x/crypto to 0.56.0 for the latest SSH security fixes and check reachable Go vulnerabilities before publishing.
- Revalidate saved Headscale node identities before startup and every forwarded connection, rejecting stale or reassigned destination addresses.
- Support IPv6 destinations, choose unused default service ports and report enrollment or process startup failures as errors.
- Test API contracts, local tsnet forwarding, browser flows and restart persistence before publishing an image or updating the Cloudron catalog.
- Isolate upstream dependency updates and tests from publication credentials; pass the tested image and allowed release files to separate publishing jobs.
- Restrict automatic releases to main and check its validated base before pushing images.
- Track stable Headscale, Headscale UI, Tailscale SDK and Alpine updates weekly, with SHA256/module checksum verification and downgrade protection.

## 0.29.4-1 - 2026-09-28

- Bump upstream Headscale to 0.29.4.

## 0.29.3-2 - 2026-09-21

- Rebuild for updated alpine:3.24 digest.

## 0.29.3-1 - 2026-08-03

- Bump upstream Headscale to 0.29.3.

## 0.29.2-2 - 2026-07-02

- Restore the generated default policy to Headscale's allow-all behavior by omitting ACL and grants sections.
- Migrate the exact generated empty ACL policy to the allow-all default with a timestamped backup.

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
