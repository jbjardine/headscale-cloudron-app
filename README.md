# Headscale Cloudron App

Cloudron package for [Headscale](https://headscale.net/) with SQLite storage, an optional embedded DERP STUN UDP port, and a bundled web UI at `/web`.

## Install

Recommended Cloudron community app URL:

```text
https://raw.githubusercontent.com/jbjardine/headscale-cloudron-app/main/CloudronVersions.json
```

In Cloudron, open **App Store** -> **Settings**, add the custom app store URL above, then install Headscale from the app store.

The repository and GHCR package must be public for third-party Cloudron installs. Private repositories or private GHCR packages require registry credentials on the target Cloudron.

## GHCR Fallback

Advanced users can install the published image directly from this package directory:

```sh
cloudron install --location headscale --image ghcr.io/jbjardine/headscale-cloudron-app:v0.29.2-1
```

## Release Process

1. Update `CloudronManifest.json`, `CloudronVersions.json`, and `CHANGELOG.md` for the new package version.
2. Create and push a matching Git tag, for example `v0.29.2-1`.
3. Run the `Draft Cloudron release` workflow with that tag. It creates a draft GitHub release with a `tar.gz` package that excludes `.git` and `.github`.
4. Publish the draft release. The `Publish GHCR image` workflow builds the tagged Docker image and pushes both the tag and `latest` to GHCR.
5. If needed, run `Publish GHCR image` manually with the same tag.

## Build Notes

The Docker image exposes HTTP on `8080` and optional DERP STUN UDP on container port `3478`. Persistent state is stored under `/app/data`, with SQLite at `/app/data/db.sqlite`.

Manual image build:

```sh
docker build -t ghcr.io/jbjardine/headscale-cloudron-app:v0.29.2-1 .
```
