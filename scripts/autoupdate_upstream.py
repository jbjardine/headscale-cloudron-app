#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "Dockerfile"
MANIFEST = ROOT / "CloudronManifest.json"
VERSIONS = ROOT / "CloudronVersions.json"
CHANGELOG = ROOT / "CHANGELOG.md"
README = ROOT / "README.md"
STATE = ROOT / ".github" / "upstream-state.json"
RELEASE_NOTES = ROOT / "dist" / "autoupdate-release-notes.md"
IMAGE_NAME = "ghcr.io/jbjardine/headscale-cloudron-app"
HEADSCALE_VERSION_RE = re.compile(r"\d+\.\d+\.\d+")
HEADSCALE_UI_VERSION_RE = re.compile(r"\d{4}\.\d{2}\.\d{2}")
PACKAGE_VERSION_RE = re.compile(r"\d+\.\d+\.\d+-\d+")
SHA256_RE = re.compile(r"[0-9a-f]{64}")


def require_match(name, value, pattern):
    if not pattern.fullmatch(value):
        raise SystemExit(f"Unexpected {name}: {value!r}")
    return value


def request_json(url, *, headers=None):
    request_headers = {"User-Agent": "headscale-cloudron-autoupdate"}
    if headers:
        request_headers.update(headers)
    req = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def request_bytes(url, *, headers=None):
    request_headers = {"User-Agent": "headscale-cloudron-autoupdate"}
    if headers:
        request_headers.update(headers)
    req = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def github_headers():
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def latest_github_release(repo):
    return request_json(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers=github_headers(),
    )


def asset_digest(asset):
    digest = asset.get("digest") or ""
    if digest.startswith("sha256:"):
        return require_match("asset SHA256", digest.split(":", 1)[1], SHA256_RE)

    data = request_bytes(asset["browser_download_url"], headers=github_headers())
    return require_match("asset SHA256", hashlib.sha256(data).hexdigest(), SHA256_RE)


def headscale_latest():
    release = latest_github_release("juanfont/headscale")
    tag_name = release["tag_name"]
    version = require_match("Headscale version", tag_name[1:] if tag_name.startswith("v") else tag_name, HEADSCALE_VERSION_RE)
    asset_name = f"headscale_{version}_linux_amd64"
    for asset in release.get("assets", []):
        if asset["name"] == asset_name:
            return {
                "version": version,
                "sha256": asset_digest(asset),
            }
    raise SystemExit(f"Missing Headscale release asset: {asset_name}")


def headscale_ui_latest():
    release = latest_github_release("gurucomputing/headscale-ui")
    version = require_match("Headscale UI version", release["tag_name"], HEADSCALE_UI_VERSION_RE)
    for asset in release.get("assets", []):
        if asset["name"] == "headscale-ui.zip":
            return {
                "version": version,
                "sha256": asset_digest(asset),
            }
    raise SystemExit("Missing headscale-ui.zip release asset")


def dockerhub_alpine_tags():
    tags = []
    url = "https://hub.docker.com/v2/repositories/library/alpine/tags?page_size=100"
    while url:
        data = request_json(url)
        for result in data.get("results", []):
            name = result.get("name", "")
            if re.fullmatch(r"3\.\d+", name):
                tags.append(name)
        url = data.get("next")
    if not tags:
        raise SystemExit("No Alpine 3.x Docker Hub tags found")
    return tags


def latest_alpine_tag():
    return max(dockerhub_alpine_tags(), key=lambda value: tuple(map(int, value.split("."))))


def alpine_digest(tag):
    token_url = "https://auth.docker.io/token?" + urllib.parse.urlencode(
        {
            "service": "registry.docker.io",
            "scope": "repository:library/alpine:pull",
        }
    )
    token = request_json(token_url)["token"]
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": (
            "application/vnd.oci.image.index.v1+json, "
            "application/vnd.docker.distribution.manifest.list.v2+json"
        ),
    }
    req = urllib.request.Request(
        f"https://registry-1.docker.io/v2/library/alpine/manifests/{tag}",
        headers={"User-Agent": "headscale-cloudron-autoupdate", **headers},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        digest = resp.headers.get("Docker-Content-Digest")
    if not digest:
        raise SystemExit(f"Could not resolve alpine:{tag} digest")
    return digest


def read_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def parse_dockerfile():
    text = DOCKERFILE.read_text(encoding="utf-8")
    patterns = {
        "alpine": r"^FROM alpine:(?P<value>\S+)",
        "headscale_version": r"HEADSCALE_VERSION=(?P<value>\S+)",
        "headscale_sha256": r"HEADSCALE_SHA256=(?P<value>[0-9a-f]+)",
        "headscale_ui_version": r"HEADSCALE_UI_VERSION=(?P<value>\S+)",
        "headscale_ui_sha256": r"HEADSCALE_UI_SHA256=(?P<value>[0-9a-f]+)",
    }
    values = {}
    for key, pattern in patterns.items():
        match = re.search(pattern, text, flags=re.MULTILINE)
        if not match:
            raise SystemExit(f"Could not parse {key} from Dockerfile")
        values[key] = match.group("value").rstrip(" \\")
    return text, values


def replace_docker_value(text, name, value):
    return re.sub(rf"({name}=)\S+", rf"\g<1>{value}", text)


def split_package_version(version):
    match = re.fullmatch(r"(?P<upstream>\d+\.\d+\.\d+)-(?P<package>\d+)", version)
    if not match:
        raise SystemExit(f"Unsupported package version format: {version}")
    return match.group("upstream"), int(match.group("package"))


def next_package_version(current_version, target_upstream, existing_versions):
    current_upstream, current_package = split_package_version(current_version)
    package = 1 if target_upstream != current_upstream else current_package + 1
    while f"{target_upstream}-{package}" in existing_versions:
        package += 1
    return f"{target_upstream}-{package}"


def catalog_manifest(manifest, version, upstream_version, changelog):
    data = {key: value for key, value in manifest.items() if key != "icon"}
    data["version"] = version
    data["upstreamVersion"] = upstream_version
    data["changelog"] = changelog
    data["dockerImage"] = f"{IMAGE_NAME}:v{version}"
    return data


def cloudron_date():
    now = dt.datetime.now(dt.timezone.utc)
    return now.strftime("%a, %d %b %Y 00:00:00 GMT")


def today():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def load_state():
    if not STATE.exists():
        return {}
    return read_json(STATE)


def write_outputs(path, values):
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            value = str(value)
            if "\n" in value:
                handle.write(f"{key}<<EOF\n{value}\nEOF\n")
            else:
                handle.write(f"{key}={value}\n")


def release_notes(version, reasons):
    require_match("package version", version, PACKAGE_VERSION_RE)
    lines = [
        f"Automatic Cloudron release v{version}.",
        "",
        "Changes:",
    ]
    lines.extend(f"- {reason}" for reason in reasons)
    lines.extend(
        [
            "",
            "Validation:",
            "- Cloudron catalog verification",
            "- manifest/catalog coherence check",
            "- GitHub Actions workflow lint",
            "- Docker build before publishing",
        ]
    )
    return "\n".join(lines) + "\n"


def current_release_notes(version, versions):
    require_match("package version", version, PACKAGE_VERSION_RE)
    changelog = versions["versions"].get(version, {}).get("manifest", {}).get("changelog", "").strip()
    lines = [
        f"Automatic Cloudron release v{version}.",
        "",
        "Current packaged version:",
        f"- {changelog.lstrip('- ').strip() or 'No changelog entry available.'}",
        "",
        "This run did not find a newer upstream release; these notes are used only if a missing release artifact must be repaired.",
    ]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT"))
    args = parser.parse_args()

    docker_text, current = parse_dockerfile()
    manifest = read_json(MANIFEST)
    versions = read_json(VERSIONS)
    state = load_state()
    require_match("current package version", manifest["version"], PACKAGE_VERSION_RE)

    headscale = headscale_latest()
    ui = headscale_ui_latest()
    alpine_tag = latest_alpine_tag()
    alpine_tag_digest = alpine_digest(alpine_tag)
    current_alpine_digest = alpine_digest(current["alpine"])

    reasons = []
    new_docker_text = docker_text
    target_headscale_version = current["headscale_version"]

    if headscale["version"] != current["headscale_version"]:
        target_headscale_version = headscale["version"]
        reasons.append(f"Bump upstream Headscale to {headscale['version']}.")
        new_docker_text = replace_docker_value(new_docker_text, "HEADSCALE_VERSION", headscale["version"])
        new_docker_text = replace_docker_value(new_docker_text, "HEADSCALE_SHA256", headscale["sha256"])
    elif headscale["sha256"] != current["headscale_sha256"]:
        reasons.append(f"Refresh Headscale {headscale['version']} SHA256.")
        new_docker_text = replace_docker_value(new_docker_text, "HEADSCALE_SHA256", headscale["sha256"])

    if ui["version"] != current["headscale_ui_version"]:
        reasons.append(f"Update bundled Headscale UI to {ui['version']}.")
        new_docker_text = replace_docker_value(new_docker_text, "HEADSCALE_UI_VERSION", ui["version"])
        new_docker_text = replace_docker_value(new_docker_text, "HEADSCALE_UI_SHA256", ui["sha256"])
    elif ui["sha256"] != current["headscale_ui_sha256"]:
        reasons.append(f"Refresh Headscale UI {ui['version']} SHA256.")
        new_docker_text = replace_docker_value(new_docker_text, "HEADSCALE_UI_SHA256", ui["sha256"])

    if alpine_tag != current["alpine"]:
        reasons.append(f"Move base image to Alpine {alpine_tag}.")
        new_docker_text = re.sub(r"^FROM alpine:\S+", f"FROM alpine:{alpine_tag}", new_docker_text, flags=re.MULTILINE)
    elif state.get("alpine_digest") and state.get("alpine_digest") != current_alpine_digest:
        reasons.append(f"Rebuild for updated alpine:{current['alpine']} digest.")

    if not reasons:
        RELEASE_NOTES.parent.mkdir(parents=True, exist_ok=True)
        RELEASE_NOTES.write_text(current_release_notes(manifest["version"], versions), encoding="utf-8")
        write_outputs(
            args.github_output,
            {
                "changed": "false",
                "version": manifest["version"],
                "tag": f"v{manifest['version']}",
                "release_notes_path": RELEASE_NOTES.relative_to(ROOT).as_posix(),
                "headscale_version": headscale["version"],
                "headscale_ui_version": ui["version"],
                "alpine_tag": current["alpine"],
            },
        )
        print("No upstream updates found.")
        return 0

    new_version = next_package_version(
        manifest["version"],
        target_headscale_version,
        versions["versions"],
    )
    tag = f"v{new_version}"
    changelog_text = " ".join(reasons)
    notes = release_notes(new_version, reasons)

    DOCKERFILE.write_text(new_docker_text, encoding="utf-8")

    old_version = manifest["version"]
    manifest["version"] = new_version
    manifest["upstreamVersion"] = target_headscale_version
    write_json(MANIFEST, manifest)

    entry = {
        "manifest": catalog_manifest(manifest, new_version, target_headscale_version, f"- {changelog_text}"),
        "creationDate": cloudron_date(),
        "ts": cloudron_date(),
        "publishState": "published",
    }
    versions["versions"] = {new_version: entry, **versions["versions"]}
    write_json(VERSIONS, versions)

    changelog = CHANGELOG.read_text(encoding="utf-8")
    CHANGELOG.write_text(
        changelog.replace(
            "# Changelog\n\n",
            f"# Changelog\n\n## {new_version} - {today()}\n\n- {changelog_text}\n\n",
            1,
        ),
        encoding="utf-8",
    )

    readme = README.read_text(encoding="utf-8")
    readme = readme.replace(f"v{old_version}", tag)
    README.write_text(readme, encoding="utf-8")

    STATE.parent.mkdir(parents=True, exist_ok=True)
    write_json(
        STATE,
        {
            "headscale_version": headscale["version"],
            "headscale_sha256": headscale["sha256"],
            "headscale_ui_version": ui["version"],
            "headscale_ui_sha256": ui["sha256"],
            "alpine_tag": alpine_tag if alpine_tag != current["alpine"] else current["alpine"],
            "alpine_digest": alpine_tag_digest if alpine_tag != current["alpine"] else current_alpine_digest,
            "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        },
    )

    RELEASE_NOTES.parent.mkdir(parents=True, exist_ok=True)
    RELEASE_NOTES.write_text(notes, encoding="utf-8")

    write_outputs(
        args.github_output,
        {
            "changed": "true",
            "version": new_version,
            "tag": tag,
            "release_notes_path": RELEASE_NOTES.relative_to(ROOT).as_posix(),
            "headscale_version": headscale["version"],
            "headscale_ui_version": ui["version"],
            "alpine_tag": alpine_tag,
        },
    )
    print(f"Prepared automatic release {tag}")
    for reason in reasons:
        print(f"- {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
