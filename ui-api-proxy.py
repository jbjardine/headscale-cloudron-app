#!/usr/bin/env python3

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from gateway_settings import GatewayManager


HEADSCALE_API_URL = os.environ.get("HEADSCALE_API_URL", "http://127.0.0.1:8081").rstrip("/")
API_KEY_FILE = os.environ.get("HEADSCALE_UI_API_KEY_FILE", "/app/data/ui_apikey")
LISTEN_HOST = os.environ.get("HEADSCALE_UI_PROXY_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("HEADSCALE_UI_PROXY_PORT", "8090"))
APP_ORIGIN = os.environ.get("CLOUDRON_APP_ORIGIN", "http://localhost:8080").rstrip("/")
MAX_REQUEST_BYTES = 1024 * 1024

TIMESTAMP_RE = re.compile(r"(\.\d{3})\d+(Z|[+-]\d{2}:\d{2})$")
NODE_ARRAY_FIELDS = {
    "aclTags",
    "approvedRoutes",
    "availableRoutes",
    "forcedTags",
    "invalidTags",
    "ipAddresses",
    "routes",
    "subnetRoutes",
    "tags",
    "validTags",
}
USER_NAME_FIELDS = ("name", "username", "display_name", "email")
HOP_BY_HOP_HEADERS = {
    "connection",
    "content-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def read_api_key():
    with open(API_KEY_FILE, "r", encoding="utf-8") as key_file:
        return key_file.read().strip()


def server_api(method, path, payload=None):
    request = urllib.request.Request(HEADSCALE_API_URL + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": "Bearer " + read_api_key(), "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def normalize_timestamp(value):
    if isinstance(value, str):
        return TIMESTAMP_RE.sub(r"\1\2", value)
    return value


def normalize_value(value):
    if isinstance(value, dict):
        return {key: normalize_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_value(item) for item in value]
    return normalize_timestamp(value)


def normalize_node(node):
    if not isinstance(node, dict):
        return normalize_value(node)

    normalized = {key: normalize_value(value) for key, value in node.items()}
    user = normalized.get("user")
    if isinstance(user, dict) and not _normalize_node_user_value(user.get("name")):
        for key in USER_NAME_FIELDS:
            key_value = user.get(key)
            if _normalize_node_user_value(key_value):
                user["name"] = str(key_value).strip()
                break
    for key in NODE_ARRAY_FIELDS:
        if normalized.get(key) is None:
            normalized[key] = []
    return normalized


def _normalize_node_user_value(value):
    if isinstance(value, str):
        return value.strip().lower()
    return ""


def get_node_user_sort_key(node):
    if not isinstance(node, dict):
        return ""

    user = node.get("user")
    if isinstance(user, dict):
        for key in USER_NAME_FIELDS:
            key_value = _normalize_node_user_value(user.get(key))
            if key_value:
                return key_value

    for key in USER_NAME_FIELDS:
        key_value = _normalize_node_user_value(node.get(key))
        if key_value:
            return key_value

    return _normalize_node_user_value(node.get("name"))


def sort_nodes_by_user(nodes):
    return sorted(
        nodes,
        key=lambda node: (
            get_node_user_sort_key(node),
            _normalize_node_user_value(node.get("name")) if isinstance(node, dict) else "",
        ),
    )


def normalize_json_response(path, data):
    parsed_path = urllib.parse.urlsplit(path)
    path = parsed_path.path.rstrip("/")
    data = normalize_value(data)
    if (
        path.rstrip("/") == "/api/v1/node" and
        isinstance(data, dict) and isinstance(data.get("nodes"), list)
    ):
        data["nodes"] = [normalize_node(node) for node in data["nodes"]]
        data["nodes"] = sort_nodes_by_user(data["nodes"])
    if path == "/api/v1/preauthkey" and isinstance(data, dict) and "preAuthKeys" in data:
        keys = data.get("preAuthKeys") or []
        user_ids = urllib.parse.parse_qs(parsed_path.query).get("user")
        if user_ids:
            # Headscale 0.29 lists every user's keys. The bundled UI still sends
            # the old ?user= filter, so retain that filter at the package boundary.
            keys = [key for key in keys if str((key.get("user") or {}).get("id")) == user_ids[0]]
        for key in keys:
            key["aclTags"] = key.get("aclTags") or []
        data["preAuthKeys"] = keys
    return data


class HeadscaleUiProxyHandler(BaseHTTPRequestHandler):
    server_version = "HeadscaleUiProxy/1.0"

    def do_DELETE(self):
        self.proxy_request()

    def do_GET(self):
        self.proxy_request()

    def do_HEAD(self):
        self.proxy_request()

    def do_OPTIONS(self):
        self.proxy_request()

    def do_PATCH(self):
        self.proxy_request()

    def do_POST(self):
        self.proxy_request()

    def do_PUT(self):
        self.proxy_request()

    def log_message(self, message, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), message % args))
        sys.stdout.flush()

    def proxy_request(self):
        request_path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if any(segment in (".", "..") for segment in request_path.split("/")) or "\\" in request_path or "//" in request_path:
            self.send_text_response(400, "Use a canonical API path")
            return
        if not request_path.startswith("/api/"):
            self.send_text_response(404, "Not found")
            return

        if self.command not in ("GET", "HEAD", "OPTIONS"):
            origin = self.headers.get("Origin")
            if (origin and origin != APP_ORIGIN) or (not origin and self.headers.get("X-Headscale-UI") != "1"):
                self.send_text_response(403, "Use the authenticated, same-origin Headscale UI")
                return

        if request_path.startswith("/api/v1/apikey") and self.command not in ("GET", "HEAD", "OPTIONS"):
            self.send_text_response(403, "Headscale API key management is disabled in the browser UI")
            return

        try:
            api_key = read_api_key()
        except OSError as error:
            self.send_text_response(503, "Headscale UI API key is not ready")
            self.log_message("API key read failed: %s", error)
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self.send_text_response(400, "Invalid Content-Length")
            return
        if content_length < 0:
            self.send_text_response(400, "Invalid Content-Length")
            return
        if content_length > MAX_REQUEST_BYTES:
            self.send_text_response(413, "Request body is too large")
            return
        self.connection.settimeout(30)
        try:
            body = self.rfile.read(content_length) if content_length else None
        except OSError:
            self.send_text_response(400, "Incomplete request body")
            return
        if body is not None and len(body) != content_length:
            self.send_text_response(400, "Incomplete request body")
            return
        if request_path.rstrip("/") == "/api/v1/package/gateway":
            try:
                if self.command in ("GET", "HEAD"):
                    result = self.server.gateway.public()
                elif self.command == "PUT":
                    result = self.server.gateway.save(json.loads(body or b"{}"))
                else:
                    self.send_text_response(405, "Use GET or PUT for gateway settings")
                    return
                self.send_json_response(200, result)
            except (ValueError, TypeError, UnicodeDecodeError) as error:
                self.send_text_response(400, str(error))
            except OSError:
                self.send_text_response(503, "Gateway settings or Headscale API are unavailable")
            return
        headers = {
            "Accept": self.headers.get("Accept", "application/json"),
            "Authorization": "Bearer %s" % api_key,
        }

        content_type = self.headers.get("Content-Type")
        if content_type:
            headers["Content-Type"] = content_type

        if request_path.rstrip("/") == "/api/v1/preauthkey/expire" and self.command == "POST":
            try:
                payload = json.loads(body or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError
                if "id" not in payload:
                    # The old UI submits a public key prefix and user ID. It
                    # must be resolved to an ID; forwarding it unchanged gives
                    # an HTTP 200 while expiring ID 0 (and therefore no key).
                    public_key = payload.get("key")
                    user_id = str(payload.get("user", ""))
                    if not public_key or not user_id.isdecimal():
                        raise ValueError
                    lookup = urllib.request.Request(
                        HEADSCALE_API_URL + "/api/v1/preauthkey",
                        headers={"Accept": "application/json", "Authorization": "Bearer " + api_key},
                    )
                    with urllib.request.urlopen(lookup, timeout=30) as response:
                        keys = json.load(response).get("preAuthKeys") or []
                    matches = [key for key in keys if key.get("key") == public_key
                               and str((key.get("user") or {}).get("id")) == user_id]
                    if len(matches) != 1:
                        self.send_text_response(409, "This key could not be identified. Refresh the key list and try again.")
                        return
                    payload = {"id": matches[0]["id"]}
                key_id = payload["id"]
                if isinstance(key_id, bool) or not str(key_id).isdecimal() or not 0 < int(key_id) < 2**64:
                    raise ValueError
                body = json.dumps({"id": str(key_id)}).encode("utf-8")
                headers["Content-Type"] = "application/json"
            except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                self.send_text_response(400, "A valid enrollment key ID is required")
                return
            except OSError as error:
                self.send_text_response(502, "The enrollment key list could not be loaded")
                self.log_message("Enrollment key lookup failed: %s", type(error).__name__)
                return

        target_url = HEADSCALE_API_URL + self.path
        request = urllib.request.Request(target_url, data=body, headers=headers, method=self.command)

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                response_status = response.status
                response_headers = response.headers
                response_body = response.read()
        except urllib.error.HTTPError as error:
            response_status = error.code
            response_headers = error.headers
            response_body = error.read()
        except OSError as error:
            self.send_text_response(502, "Headscale API proxy error")
            self.log_message("Headscale API proxy error: %s", error)
            return

        response_body, response_headers = self.maybe_normalize_json(
            self.path,
            response_body,
            response_headers,
        )
        self.send_response(response_status)
        for key, value in response_headers.items():
            if key.lower() not in HOP_BY_HOP_HEADERS:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(response_body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(response_body)

    def maybe_normalize_json(self, request_path, response_body, response_headers):
        content_type = response_headers.get("Content-Type", "")
        if "application/json" not in content_type:
            return response_body, response_headers

        try:
            parsed_body = json.loads(response_body.decode("utf-8"))
            normalized_body = normalize_json_response(request_path, parsed_body)
            response_body = json.dumps(normalized_body, separators=(",", ":")).encode("utf-8")
            response_headers.replace_header("Content-Type", "application/json; charset=utf-8")
        except (LookupError, UnicodeDecodeError, json.JSONDecodeError):
            pass
        return response_body, response_headers

    def send_text_response(self, status, message):
        self.send_json_response(status, {"message": message})

    def send_json_response(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


def main():
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), HeadscaleUiProxyHandler)
    server.gateway = GatewayManager(server_api, APP_ORIGIN, api_url=HEADSCALE_API_URL, api_key_file=API_KEY_FILE)
    server.gateway.start()
    print("Headscale UI API proxy listening on %s:%s" % (LISTEN_HOST, LISTEN_PORT))
    try:
        server.serve_forever()
    finally:
        server.gateway.close()
        server.server_close()


if __name__ == "__main__":
    main()
