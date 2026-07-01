#!/usr/bin/env python3

import json
import os
import re
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HEADSCALE_API_URL = os.environ.get("HEADSCALE_API_URL", "http://127.0.0.1:8081").rstrip("/")
API_KEY_FILE = os.environ.get("HEADSCALE_UI_API_KEY_FILE", "/app/data/ui_apikey")
LISTEN_HOST = os.environ.get("HEADSCALE_UI_PROXY_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("HEADSCALE_UI_PROXY_PORT", "8090"))

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
    for key in NODE_ARRAY_FIELDS:
        if normalized.get(key) is None:
            normalized[key] = []
    return normalized


def normalize_json_response(path, data):
    data = normalize_value(data)
    if path.startswith("/api/v1/node") and isinstance(data, dict) and isinstance(data.get("nodes"), list):
        data["nodes"] = [normalize_node(node) for node in data["nodes"]]
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
        request_path = self.path.split("?", 1)[0]
        if not request_path.startswith("/api/"):
            self.send_text_response(404, "Not found")
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

        content_length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(content_length) if content_length else None
        headers = {
            "Accept": self.headers.get("Accept", "application/json"),
            "Authorization": "Bearer %s" % api_key,
        }

        content_type = self.headers.get("Content-Type")
        if content_type:
            headers["Content-Type"] = content_type

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
            request_path,
            response_body,
            response_headers,
        )
        self.send_response(response_status)
        for key, value in response_headers.items():
            if key.lower() not in HOP_BY_HOP_HEADERS:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(response_body)))
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
        body = message.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


def main():
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), HeadscaleUiProxyHandler)
    print("Headscale UI API proxy listening on %s:%s" % (LISTEN_HOST, LISTEN_PORT))
    server.serve_forever()


if __name__ == "__main__":
    main()
