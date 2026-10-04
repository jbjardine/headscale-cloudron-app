#!/usr/bin/env python3
"""Freeze release inputs before dependency execution; treat them as data later."""
import argparse
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path, PurePosixPath


RELEASE_FILES = (
    "Dockerfile", "gateway/go.mod", "gateway/go.sum", "CloudronManifest.json",
    "CloudronVersions.json", "README.md", "CHANGELOG.md", ".github/upstream-state.json",
)
NOTES = "dist/autoupdate-release-notes.md"
IMAGE = "ghcr.io/jbjardine/headscale-cloudron-app"


def sha256(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def validate_digest(path, expected):
    if not re.fullmatch(r"[0-9a-f]{64}", expected) or sha256(path) != expected:
        raise ValueError("Publication input digest mismatch")


def safe_members(archive):
    seen = set()
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if (not member.isfile() or path.is_absolute() or ".." in path.parts
                or member.name != path.as_posix() or member.name in seen):
            raise ValueError("Publication snapshot contains an invalid entry")
        seen.add(member.name)
    return archive.getmembers()


def freeze(root, destination, *, generated=False, notes=False):
    root = Path(root).resolve()
    if generated:
        changed = subprocess.check_output(["git", "diff", "--name-only", "-z", "HEAD"], cwd=root).decode().split("\0")
        if set(filter(None, changed)) - set(RELEASE_FILES):
            raise ValueError("Updater modified a file outside the release allowlist")
        untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
        if set(filter(None, untracked)) - {NOTES}:
            raise ValueError("Updater created an unexpected untracked file")
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
    names = set(filter(None, names))
    if notes:
        names.add(NOTES)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination, "w:gz") as archive:
        for name in sorted(names):
            path = root / name
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
                raise ValueError("Snapshot source is not a regular repository file")
            archive.add(path, arcname=name, recursive=False)
    return sha256(destination)


def unpack(snapshot, digest, destination):
    validate_digest(snapshot, digest)
    with tarfile.open(snapshot, "r:gz") as archive:
        members = safe_members(archive)
        # No executable dependency is run before this authenticated extraction.
        for member in members:
            path = Path(destination) / member.name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(archive.extractfile(member).read())
            path.chmod(member.mode & 0o777)


def publication_data(snapshot, digest, tag, destination, *, copy_to=None):
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+", tag):
        raise ValueError("Invalid release tag")
    validate_digest(snapshot, digest)
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(snapshot, "r:gz") as archive:
        members = safe_members(archive)
        names = {member.name for member in members}
        if not set((*RELEASE_FILES, NOTES)).issubset(names):
            raise ValueError("Missing release data")
        data = {name: archive.extractfile(name).read() for name in (*RELEASE_FILES, NOTES)}
        manifest = json.loads(data["CloudronManifest.json"])
        catalog = json.loads(data["CloudronVersions.json"])
        version = tag[1:]
        entry = catalog["versions"][version]
        if manifest.get("id") != "io.github.jbjardine.headscale-cloudron-app" or manifest.get("version") != version:
            raise ValueError("Release manifest mismatch")
        if (entry.get("publishState") != "published"
                or entry["manifest"].get("dockerImage") != IMAGE + ":" + tag
                or entry["manifest"].get("version") != version):
            raise ValueError("Release catalog mismatch")
        (destination / "release-notes.md").write_bytes(data[NOTES])
        # Create the public source archive from the original frozen inputs,
        # never from the checkout in which tests or dependency code ran.
        with tarfile.open(destination / f"headscale-cloudron-app-{tag}.tar.gz", "w:gz") as public:
            for member in members:
                if set(PurePosixPath(member.name).parts) & {".git", ".github", ".workflow", "dist", "node_modules", "__pycache__"}:
                    continue
                content = archive.extractfile(member).read()
                info = tarfile.TarInfo("./" + member.name)
                info.size, info.mode, info.mtime = len(content), member.mode, member.mtime
                public.addfile(info, io.BytesIO(content))
    if copy_to is not None:
        for name in RELEASE_FILES:
            path = Path(copy_to) / name
            if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
                raise ValueError("Invalid release destination")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data[name])


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("freeze")
    create.add_argument("destination")
    create.add_argument("--root", default=".")
    create.add_argument("--generated", action="store_true")
    create.add_argument("--notes", action="store_true")
    extract = sub.add_parser("unpack")
    extract.add_argument("snapshot")
    extract.add_argument("digest")
    extract.add_argument("destination")
    publish = sub.add_parser("publication-data")
    publish.add_argument("snapshot")
    publish.add_argument("digest")
    publish.add_argument("tag")
    publish.add_argument("destination")
    publish.add_argument("--copy-to")
    args = parser.parse_args()
    if args.command == "freeze":
        print(freeze(args.root, args.destination, generated=args.generated, notes=args.notes))
    elif args.command == "unpack":
        unpack(args.snapshot, args.digest, args.destination)
    else:
        publication_data(args.snapshot, args.digest, args.tag, args.destination, copy_to=args.copy_to)


if __name__ == "__main__":
    main()
