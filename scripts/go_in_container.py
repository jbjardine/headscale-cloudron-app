#!/usr/bin/env python3
"""Run imported SDK code with read-only sources and no host credentials/socket."""
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    version = re.search(r"^FROM golang:([0-9]+\.[0-9]+\.[0-9]+)-alpine AS gateway-build$", (root / "Dockerfile").read_text(), re.MULTILINE)
    if not version:
        raise SystemExit("A fixed Go builder version is required")
    cwd = Path.cwd().resolve().relative_to(root)
    cache = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "headscale-isolated-go"
    for name in ("modules", "sumdb", "build"):
        (cache / name).mkdir(parents=True, exist_ok=True)
    docker = ["docker"]
    if os.environ.get("HEADSCALE_TEST_DOCKER_HOST"):
        docker.append("--host=" + os.environ["HEADSCALE_TEST_DOCKER_HOST"])
    tool_image = "headscale-isolated-go:" + version[1]
    exists = subprocess.run(docker + ["image", "inspect", tool_image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if exists.returncode:
        # Alpine plus a C compiler supports race tests without a large Debian
        # image. The build context is this literal Dockerfile, not the repo.
        build = docker + ["build", "--pull", "-t", tool_image, "-"]
        if os.environ.get("CODEX_PROXY_CERT"):
            build[-1:-1] = ["--secret", "id=proxy_ca,src=" + os.environ["CODEX_PROXY_CERT"]]
        dockerfile = (f"FROM golang:{version[1]}-alpine\n"
                      "RUN --mount=type=secret,id=proxy_ca "
                      "if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; "
                      "apk add --no-cache build-base\n")
        subprocess.run(build, input=dockerfile, text=True, check=True)
    command = docker + ["run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}", "--network=host", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,exec,nosuid",
                       "--mount", f"type=bind,src={root},dst=/src,readonly",
                       "--mount", f"type=bind,src={cache / 'modules'},dst=/go/pkg/mod",
                       "--mount", f"type=bind,src={cache / 'sumdb'},dst=/go/pkg/sumdb",
                       "--mount", f"type=bind,src={cache / 'build'},dst=/go/build-cache",
                       "-w", "/src/" + cwd.as_posix(), "-e", "GOCACHE=/go/build-cache", "-e", "GOFLAGS=-p=4", "-e", "TS_DISABLE_LOGTAIL=true"]
    # Only public network settings and local fixture coordinates cross this
    # boundary. GitHub/Cloudron keys, runner tokens and Docker socket do not.
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "HEADSCALE_TEST_URL", "HEADSCALE_TEST_USER", "HEADSCALE_TEST_DERP", "HEADSCALE_TEST_STUN_PORT"):
        if os.environ.get(name):
            command += ["-e", name + "=" + os.environ[name]]
    if os.environ.get("CODEX_PROXY_CERT"):
        command += ["--mount", f"type=bind,src={os.environ['CODEX_PROXY_CERT']},dst=/run/public-proxy-ca.pem,readonly", "-e", "SSL_CERT_FILE=/run/public-proxy-ca.pem"]
    command += [tool_image, "go", *sys.argv[1:]]
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
