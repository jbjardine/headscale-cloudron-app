#!/usr/bin/env python3
"""Exercise the packaged Headscale API using disposable local data only."""
import argparse
import datetime as dt
import json
import ipaddress
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--docker-host")
    parser.add_argument("--check-tsnet", action="store_true")
    parser.add_argument("--check-derp", action="store_true")
    parser.add_argument("--go-binary", default="go")
    args = parser.parse_args()
    docker = ["docker"] + (["--host=" + args.docker_host] if args.docker_host else [])
    name = "headscale-smoke-" + uuid.uuid4().hex[:12]
    def command(*values):
        return subprocess.check_output(docker + list(values), text=True).strip()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    if args.check_derp:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as listener:
            listener.bind(("127.0.0.1", 0))
            stun_port = listener.getsockname()[1]
    # No public proxy is used for the disposable localhost fixture.
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def api(method, path, payload=None, headers=None):
        request = urllib.request.Request(base + path, method=method,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json", "X-Headscale-UI": "1", **(headers or {})})
        with http.open(request, timeout=10) as response:
            body = response.read()
            return json.loads(body) if body else {}
    def wait_ready():
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                api("GET", "/health")
                api("GET", "/web/api/v1/user")
                return
            except (OSError, ValueError):
                time.sleep(.25)
        raise RuntimeError("The packaged app did not become ready")
    def check_stun():
        transaction = os.urandom(12)
        request = struct.pack("!HHI", 1, 0, 0x2112A442) + transaction
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
            connection.settimeout(3)
            connection.sendto(request, ("127.0.0.1", stun_port))
            response, _ = connection.recvfrom(2048)
        assert len(response) >= 20 and response[8:20] == transaction, "STUN transaction mismatch"
        kind, length, cookie = struct.unpack("!HHI", response[:8])
        assert (kind, cookie) == (0x0101, 0x2112A442) and length == len(response) - 20, "Invalid STUN binding response"
        offset = 20
        while offset < len(response):
            attribute, size = struct.unpack("!HH", response[offset:offset + 4])
            value = response[offset + 4:offset + 4 + size]
            if attribute == 0x0020:
                assert size == 8 and value[1] == 1, "Invalid STUN IPv4 mapped address"
                assert struct.unpack("!H", value[2:4])[0] ^ 0x2112 > 0, "Invalid STUN mapped port"
                address = bytes(a ^ b for a, b in zip(value[4:8], struct.pack("!I", cookie)))
                assert not ipaddress.IPv4Address(address).is_unspecified, "Invalid STUN mapped IP"
                return
            offset += 4 + (size + 3) // 4 * 4
        raise AssertionError("STUN did not report the XOR mapped address")
    with tempfile.TemporaryDirectory(prefix="headscale-smoke-") as directory:
        data = Path(directory) / "data"
        data.mkdir()
        arguments = ["run", "-d", "--name", name, "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=DAC_OVERRIDE",
                     "-p", f"127.0.0.1:{port}:8080", "-e", "CLOUDRON_APP_ORIGIN=" + base,
                     "--mount", f"type=bind,src={data},dst=/app/data"]
        if args.check_derp:
            arguments += ["-p", f"127.0.0.1:{stun_port}:3478/udp", "-e", f"DERP_PORT={stun_port}"]
        if os.environ.get("CODEX_PROXY_CERT"):
            arguments += ["--mount", f"type=bind,src={os.environ['CODEX_PROXY_CERT']},dst=/run/cloud-proxy-ca.pem,readonly",
                          "-e", "SSL_CERT_FILE=/run/cloud-proxy-ca.pem"]
        try:
            command(*arguments, args.image)
            wait_ready()
            first = api("POST", "/web/api/v1/user", {"name": "smoke-first"})["user"]["id"]
            second = api("POST", "/web/api/v1/user", {"name": "smoke-second"})["user"]["id"]
            expiration = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=7)).isoformat()
            keys = []
            for user in (first, second):
                keys.append(api("POST", "/web/api/v1/preauthkey", {"user": user, "expiration": expiration,
                            "reusable": True, "ephemeral": False})["preAuthKey"])
            assert all(key.get("key") for key in keys), "Creation did not return a full key"
            listed = api("GET", f"/web/api/v1/preauthkey?user={first}")["preAuthKeys"]
            assert len(listed) == 1 and listed[0]["id"] == keys[0]["id"], "User key filtering regressed"
            assert listed[0]["key"] != keys[0]["key"], "A stored enrollment secret was returned"
            # The upstream UI still uses this legacy expiry request.
            api("POST", "/web/api/v1/preauthkey/expire", {"user": first, "key": listed[0]["key"]})
            listed = api("GET", f"/web/api/v1/preauthkey?user={first}")["preAuthKeys"]
            assert dt.datetime.fromisoformat(listed[0]["expiration"].replace("Z", "+00:00")) <= dt.datetime.now(dt.timezone.utc), "Legacy expiration reported success without expiring the key"
            other = api("GET", f"/web/api/v1/preauthkey?user={second}")["preAuthKeys"]
            assert dt.datetime.fromisoformat(other[0]["expiration"].replace("Z", "+00:00")) > dt.datetime.now(dt.timezone.utc), "Wrong user's key was expired"
            api("POST", "/web/api/v1/preauthkey/expire", {"id": keys[1]["id"]})
            if args.check_tsnet:
                sdk_environment = {**os.environ, "HEADSCALE_TEST_URL": base, "HEADSCALE_TEST_USER": str(first)}
                subprocess.run([args.go_binary, "test", "-run", "^TestPackagedHeadscaleEnrollment$", "-count=1", "-timeout=60s", "."],
                               cwd=Path(__file__).resolve().parents[1] / "gateway", env=sdk_environment, check=True, timeout=300)
            gateway = api("GET", "/web/api/v1/package/gateway")
            assert not gateway["settings"]["enabled"] and not gateway["hasOfficialKey"], "Gateway should be disabled on installation"
            api("PUT", "/web/api/v1/package/gateway", gateway["settings"])
            for path in ("/web/keys.html", "/web/gateway.html", "/web/package-ui.js", "/web/devices.html"):
                with http.open(base + path) as response:
                    assert response.status == 200 and response.read(), "Missing packaged UI asset"
            try:
                api("POST", "/web/api/v1/user", {"name": "cross-origin"}, {"Origin": "https://untrusted.example"})
                raise AssertionError("Cross-origin administration was allowed")
            except urllib.error.HTTPError as error:
                assert error.code == 403
            assert "headscale-gateway" not in command("top", name, "-eo", "pid,args"), "Disabled gateway started a VPN client"
            command("restart", name)
            wait_ready()
            assert len(api("GET", "/web/api/v1/user")["users"]) == 2, "Users did not survive restart"
            assert any(key["id"] == keys[0]["id"] for key in api("GET", f"/web/api/v1/preauthkey?user={first}")["preAuthKeys"]), "Keys did not survive restart"
            assert not api("GET", "/web/api/v1/package/gateway")["settings"]["enabled"]
            if args.check_derp:
                command("exec", name, "python3", "-c", "import yaml; p='/app/data/config.yaml'; c=yaml.safe_load(open(p)); c['derp']['server']['enabled']=True; c['derp']['urls']=[]; c['derp']['auto_update_enabled']=False; open(p,'w').write(yaml.safe_dump(c,sort_keys=False))")
                command("restart", name)
                wait_ready()
                mapped = json.loads(command("exec", name, "python3", "-c", "import json,yaml; print(json.dumps(yaml.safe_load(open('/run/headscale/cloudron-derp.yaml'))))"))
                assert mapped["regions"]["999"]["nodes"][0]["stunport"] == stun_port, "Wrong public STUN port advertised"
                derp_key = command("exec", name, "sha256sum", "/app/data/derp_server_private.key")
                sdk_environment = {**os.environ, "HEADSCALE_TEST_URL": base, "HEADSCALE_TEST_USER": str(first), "HEADSCALE_TEST_DERP": "1"}
                def check_relay():
                    subprocess.run([args.go_binary, "test", "-v", "-run", "^TestPackagedEmbeddedDERP$", "-count=1", "-timeout=60s", "."],
                                   cwd=Path(__file__).resolve().parents[1] / "gateway", env=sdk_environment, check=True, timeout=300)
                    check_stun()
                check_relay()
                command("restart", name)
                wait_ready()
                assert command("exec", name, "sha256sum", "/app/data/derp_server_private.key") == derp_key, "DERP identity changed after restart"
                check_relay()
                command("exec", name, "python3", "-c", "import yaml; p='/app/data/config.yaml'; c=yaml.safe_load(open(p)); c['derp']['server']['enabled']=False; open(p,'w').write(yaml.safe_dump(c,sort_keys=False))")
                command("restart", name)
                wait_ready()
                print("Embedded DERP passed: bidirectional relay, registered-client verification, unknown-client rejection, public STUN UDP response/advertisement, stable identity after restart, disable/restart")
            print("Packaged API smoke passed: creation, one-time secret, user filtering, both expiry APIs, CSRF, default-off gateway, restart persistence; no NET_ADMIN capability")
        finally:
            subprocess.run(docker + ["exec", name, "chown", "-R", f"{os.getuid()}:{os.getgid()}", "/app/data"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            subprocess.run(docker + ["rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
