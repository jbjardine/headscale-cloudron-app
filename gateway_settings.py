"""Private gateway settings and lifecycle behind Cloudron's authenticated UI."""

import datetime as dt
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time


DEFAULTS = {
    "enabled": False,
    "headscaleUserId": "",
    "sourceMode": "restricted",
    "allowedSources": [],
    "maxConnections": 16,
    "maxBytesPerSecond": 0,
    "idleTimeoutSeconds": 900,
    "rules": [],
}
OFFICIAL_KEY = re.compile(r"tskey-auth-[A-Za-z0-9-]+\Z")
TAILNETS = (ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48"))


def numeric_id(value):
    return not isinstance(value, bool) and str(value).isdecimal() and 0 < int(value) < 2**64


def integer(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{label} must be between {low} and {high}")
    return value


def tailnet_ip(value):
    address = ipaddress.ip_address(value)
    if not any(address.version == network.version and address in network for network in TAILNETS):
        raise ValueError("Choose a Headscale node's VPN address")
    return str(address)


def validate_settings(payload):
    if not isinstance(payload, dict) or set(payload) - (set(DEFAULTS) | {"officialAuthKey"}):
        raise ValueError("Invalid gateway settings")
    data = {**DEFAULTS, **payload}
    key = data.pop("officialAuthKey", "")
    if not isinstance(key, str) or (key and not OFFICIAL_KEY.fullmatch(key)):
        raise ValueError("Use an official Tailscale auth key beginning with tskey-auth-")
    if not isinstance(data["enabled"], bool):
        raise ValueError("Enabled must be true or false")
    user = data["headscaleUserId"]
    if user != "" and not numeric_id(user):
        raise ValueError("Choose a Headscale user")
    data["headscaleUserId"] = str(user)
    if data["enabled"] and not user:
        raise ValueError("Choose a Headscale user for the gateway")
    if data["sourceMode"] not in ("restricted", "tailnet"):
        raise ValueError("Choose the allowed source mode")
    sources = data["allowedSources"]
    if not isinstance(sources, list) or len(sources) > 64:
        raise ValueError("Enter at most 64 source IP addresses or networks")
    normalized = []
    for source in sources:
        if not isinstance(source, str):
            raise ValueError("Invalid source network")
        try:
            prefix = ipaddress.ip_network(source, strict=False)
        except ValueError:
            raise ValueError("Invalid source IP address or CIDR network") from None
        if not any(prefix.version == network.version and prefix.subnet_of(network) for network in TAILNETS):
            raise ValueError("Source networks must be Tailscale VPN addresses")
        normalized.append(str(prefix))
    data["allowedSources"] = list(dict.fromkeys(normalized))
    data["maxConnections"] = integer(data["maxConnections"], 1, 512, "Connection limit")
    data["maxBytesPerSecond"] = integer(data["maxBytesPerSecond"], 0, 1_000_000_000, "Bytes per second")
    data["idleTimeoutSeconds"] = integer(data["idleTimeoutSeconds"], 30, 86400, "Idle timeout in seconds")
    rules = data["rules"]
    if not isinstance(rules, list) or len(rules) > 64:
        raise ValueError("Configure at most 64 TCP services")
    cleaned, ports = [], set()
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) != {"nodeId", "targetIp", "targetPort", "listenPort"} or not numeric_id(rule["nodeId"]):
            raise ValueError("Choose a Headscale machine for each service")
        port = integer(rule["listenPort"], 1024, 65535, "Gateway port")
        if port in ports:
            raise ValueError("Each service needs a different gateway port")
        ports.add(port)
        cleaned.append({"nodeId": str(rule["nodeId"]), "targetIp": tailnet_ip(rule["targetIp"]),
                        "targetPort": integer(rule["targetPort"], 1, 65535, "Destination port"), "listenPort": port})
    data["rules"] = cleaned
    if data["enabled"] and rules and data["sourceMode"] == "restricted" and not normalized:
        raise ValueError("Add allowed source addresses, or explicitly allow the whole Tailscale network")
    return data, key


def private_write(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class GatewayManager:
    def __init__(self, api, origin, directory="/app/data/gateway", binary="/usr/local/bin/headscale-gateway",
                 api_url="http://127.0.0.1:8081", api_key_file="/app/data/ui_apikey"):
        self.api, self.origin = api, origin
        self.directory, self.binary = Path(directory), binary
        self.api_url, self.api_key_file = api_url.rstrip("/"), api_key_file
        self.lock = threading.RLock()
        self.process = None
        self.running_settings = None
        self.message = "Gateway disabled"
        self.start_error = False
        self.retry_at = 0
        self.stop_event = threading.Event()

    def settings(self):
        try:
            data = json.loads((self.directory / "settings.json").read_text())
            return validate_settings(data)[0]
        except FileNotFoundError:
            return json.loads(json.dumps(DEFAULTS))

    def public(self):
        with self.lock:
            settings = self.settings()
            state = {"state": "disabled" if not settings["enabled"] else "error" if self.start_error else "connecting", "message": self.message}
            if settings["enabled"] and self.process is not None and not self.start_error:
                try:
                    saved = json.loads((self.directory / "status.json").read_text())
                    # The Go binary writes only this status DTO, never keys or
                    # authentication URLs. Reject stale running status on exit.
                    fields = {"state", "message", "officialIps", "headscaleIps", "activeConnections",
                              "acceptedConnections", "deniedConnections", "transferredBytes"}
                    state.update({key: value for key, value in saved.items() if key in fields})
                    if self.process.poll() is not None and state.get("state") == "running":
                        state = {"state": "error", "message": "Gateway stopped; retrying the connection"}
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
            return {"settings": settings, "hasOfficialKey": (self.directory / "official.key").is_file(), "status": state}

    def save(self, payload):
        settings, key = validate_settings(payload)
        if settings["enabled"]:
            users = self.api("GET", "/api/v1/user").get("users") or []
            if not any(str(user["id"]) == settings["headscaleUserId"] for user in users):
                raise ValueError("The selected Headscale user no longer exists")
            nodes = self.api("GET", "/api/v1/node").get("nodes") or []
            addresses = {str(node["id"]): node.get("ipAddresses") or [] for node in nodes}
            if any(rule["targetIp"] not in addresses.get(rule["nodeId"], []) for rule in settings["rules"]):
                raise ValueError("A selected machine or address no longer exists; refresh the machine list")
        with self.lock:
            if settings["enabled"] and not key and not (self.directory / "official.key").is_file():
                raise ValueError("Add an official Tailscale auth key before enabling the gateway")
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.directory.chmod(0o700)
            if key:
                private_write(self.directory / "official.key", key)
            private_write(self.directory / "settings.json", json.dumps(settings))
            self.stop_process()
            (self.directory / "status.json").unlink(missing_ok=True)
            self.message = "Connecting the gateway" if settings["enabled"] else "Gateway disabled"
            self.start_error = False
            self.retry_at = 0
            return self.public()

    def stop_process(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process = None
        self.running_settings = None

    def prepare_enrollment(self, settings):
        directory = self.directory / ("headscale-" + settings["headscaleUserId"])
        directory.mkdir(mode=0o700, exist_ok=True)
        key_path = directory / "enrollment.key"
        # Registered tsnet identities reuse their private persistent state.
        # Only an unregistered identity needs a fresh short-lived join key.
        if (directory / "enrolled").is_file() and (directory / "tailscaled.state").is_file():
            return
        if key_path.is_file() and time.time() - key_path.stat().st_mtime < 1800:
            return
        expiration = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).isoformat()
        result = self.api("POST", "/api/v1/preauthkey", {"user": settings["headscaleUserId"], "reusable": False,
                                                       "ephemeral": False, "expiration": expiration})
        key = result.get("preAuthKey", {}).get("key")
        if not key:
            raise ValueError("Headscale enrollment key was not returned")
        private_write(key_path, key)

    def tick(self):
        try:
            self._tick()
        except (OSError, ValueError, KeyError):
            with self.lock:
                self.start_error = True
                self.message = "Gateway could not start; check its keys, user and connectivity"
                self.retry_at = time.monotonic() + 30

    def _tick(self):
        with self.lock:
            settings = self.settings()
            if not settings["enabled"]:
                self.stop_process()
                return
            if self.process is not None and self.process.poll() is None:
                return
            if time.monotonic() < self.retry_at:
                return
            self.prepare_enrollment(settings)
            (self.directory / "status.json").unlink(missing_ok=True)
            # Keys are read from private files, never command-line arguments.
            self.process = subprocess.Popen([self.binary, "--config", str(self.directory / "settings.json"),
                                             "--state-dir", str(self.directory), "--headscale-url", self.origin,
                                             "--headscale-api-url", self.api_url, "--api-key-file", self.api_key_file])
            self.running_settings = settings
            self.message = "Connecting the gateway"
            self.start_error = False
            self.retry_at = time.monotonic() + 150

    def start(self):
        def run():
            while not self.stop_event.is_set():
                self.tick()
                self.stop_event.wait(2)
        threading.Thread(target=run, daemon=True, name="gateway-manager").start()

    def close(self):
        self.stop_event.set()
        with self.lock:
            self.stop_process()
