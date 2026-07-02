# Headscale Cloudron App

If this project is useful to you, you can support its development here:

[![Support](https://img.shields.io/badge/Support-Buy%20Me%20a%20Coffee-1f2937)](https://www.buymeacoffee.com/jbjardine)

Cloudron package for [Headscale](https://headscale.net/), the self-hosted, Tailscale-compatible coordination server for WireGuard-based private networks.

This package ships Headscale with SQLite persistence, Cloudron proxy authentication for the bundled web UI, an optional embedded DERP STUN UDP port, public GHCR images, and automatic upstream update publishing.

## Features

- Headscale packaged for Cloudron with persistent SQLite storage under `/app/data`.
- Bundled Headscale UI available at `/web`, protected by Cloudron proxy auth.
- Optional embedded DERP STUN UDP port exposed on container port `3478`.
- Read-only browser-side UI API proxy that keeps the Headscale API token server-side.
- Published GHCR images for Cloudron installs and advanced direct installs.
- Weekly automatic update checks for Headscale, Headscale UI, and Alpine base image changes.

## Install

Add this community app store URL in Cloudron:

```text
https://raw.githubusercontent.com/jbjardine/headscale-cloudron-app/main/CloudronVersions.json
```

In Cloudron, open **App Store** -> **Settings**, add the URL above, then install **Headscale** from the custom app store.

The repository and GHCR package are public so third-party Cloudron installs can pull the catalog and image without registry credentials.

## GHCR Fallback

Advanced users can install the published image directly from this package directory:

```sh
cloudron install --location headscale --image ghcr.io/jbjardine/headscale-cloudron-app:v0.29.2-2
```

## Updates

The `Autopublish upstream updates` GitHub Actions workflow checks upstream releases once a week. When Headscale, Headscale UI, or the Alpine base image changes, it updates the Cloudron package metadata, validates the catalog, builds the Docker image on GitHub Actions, pushes GHCR tags, and publishes the GitHub release automatically.

The current package tracks:

- Headscale `0.29.2`
- Headscale UI `2026.03.17`
- Alpine `3.24`

## Build Notes

The Docker image exposes HTTP on `8080` and optional DERP STUN UDP on `3478/udp`. Persistent state is stored under `/app/data`, with SQLite at `/app/data/db.sqlite`.

Local Docker builds are not required for normal releases; GitHub Actions validates and builds the image on Linux runners.
