#!/usr/bin/env python3
"""Advertise Cloudron's public STUN port without changing its container listener."""
import os
from pathlib import Path
import shutil
import sys
from urllib.parse import urlsplit

import yaml


MANAGED_MAP = "/run/headscale/cloudron-derp.yaml"


def configure(path, public_port, map_path=MANAGED_MAP):
    path = Path(path)
    config = yaml.safe_load(path.read_text())
    derp = config.get("derp", {})
    server = derp.get("server", {})
    paths = derp.get("paths") or []
    if public_port is None:
        if map_path not in paths:
            return False
        public_port = server.get("stun_listen_addr", "0.0.0.0:3478").rsplit(":", 1)[-1]
    if not str(public_port).isdigit() or not 0 <= int(public_port) <= 65535:
        raise ValueError("Invalid Cloudron DERP_PORT")
    if not server.get("enabled"):
        if map_path in paths:
            derp["paths"] = [item for item in paths if item != map_path]
            server["automatically_add_embedded_derp_region"] = True
            path.write_text(yaml.safe_dump(config, sort_keys=False))
        return False
    # An explicit, independently managed DERP map remains the operator's choice.
    if not server.get("automatically_add_embedded_derp_region", True) and map_path not in paths:
        return False
    origin = urlsplit(config["server_url"])
    if origin.scheme not in ("http", "https") or not origin.hostname or origin.username or origin.password:
        raise ValueError("Invalid Headscale server_url for the DERP map")
    region_id = int(server.get("region_id", 999))
    node = {"name": str(region_id), "regionid": region_id, "hostname": origin.hostname,
            "derpport": origin.port or (443 if origin.scheme == "https" else 80),
            "stunport": int(public_port) if int(public_port) else -1,
            "ipv4": server.get("ipv4", ""), "ipv6": server.get("ipv6", "")}
    region = {"regionid": region_id, "regioncode": server.get("region_code", "headscale"),
              "regionname": server.get("region_name", "Headscale Embedded DERP"), "nodes": [node]}
    target = Path(map_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(yaml.safe_dump({"regions": {region_id: region}}, sort_keys=False))
    if server.get("automatically_add_embedded_derp_region", True) or map_path not in paths:
        backup = path.with_name(path.name + ".before-cloudron-derp")
        if not backup.exists():
            shutil.copy2(path, backup)
        server["automatically_add_embedded_derp_region"] = False
        if map_path not in paths:
            paths.append(map_path)
        derp["paths"] = paths
        path.write_text(yaml.safe_dump(config, sort_keys=False))
    return True


if __name__ == "__main__":
    configure(sys.argv[1], os.environ.get("DERP_PORT"))
