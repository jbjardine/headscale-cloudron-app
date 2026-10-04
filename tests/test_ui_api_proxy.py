import copy
import importlib.util
import json
import tempfile
import threading
import unittest
from unittest.mock import mock_open, patch
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ui_api_proxy", ROOT / "ui-api-proxy.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class Upstream(BaseHTTPRequestHandler):
    keys = []
    mutations = []

    def log_message(self, *args):
        pass

    def reply(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer server-only-test-token":
            self.send_error(401)
            return
        self.reply({"preAuthKeys": self.keys})

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.mutations.append(data)
        if self.path == "/api/v1/preauthkey/expire":
            for key in self.keys:
                if key["id"] == data.get("id"):
                    key["expiration"] = "2000-01-01T00:00:00Z"
        self.reply({})


class QuietProxy(proxy.HeadscaleUiProxyHandler):
    def log_message(self, *args):
        pass


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        path = Path(cls.temp.name) / "apikey"
        path.write_text("server-only-test-token")
        proxy.API_KEY_FILE = str(path)
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        proxy.HEADSCALE_API_URL = "http://127.0.0.1:" + str(cls.upstream.server_port)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietProxy)
        for server in [cls.upstream, cls.server]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)
        cls.client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        for server in [cls.server, cls.upstream]:
            server.shutdown()
            server.server_close()
        cls.temp.cleanup()

    def setUp(self):
        Upstream.keys = [
            {"id": "7", "key": "public-prefix-7", "user": {"id": "1"}, "aclTags": None,
             "expiration": "2099-01-01T00:00:00.123456789Z"},
            {"id": "8", "key": "public-prefix-8", "user": {"id": "2"}, "aclTags": None,
             "expiration": "2099-01-01T00:00:00Z"},
        ]
        Upstream.mutations = []

    def request(self, path, body=None, headers=None, method=None):
        request = urllib.request.Request(
            self.base + path, data=json.dumps(body).encode() if body is not None else None,
            headers=headers if headers is not None else {"X-Headscale-UI": "1", "Content-Type": "application/json"},
            method=method,
        )
        try:
            response = self.client.open(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response), response.headers

    def test_legacy_expire_really_expires_the_matching_key(self):
        status, data, headers = self.request("/api/v1/preauthkey/expire", {"user": "1", "key": "public-prefix-7"})
        self.assertEqual(status, 200)
        self.assertEqual(Upstream.mutations, [{"id": "7"}])
        self.assertEqual(Upstream.keys[0]["expiration"], "2000-01-01T00:00:00Z")
        self.assertEqual(Upstream.keys[1]["expiration"], "2099-01-01T00:00:00Z")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_native_expire_by_id(self):
        self.assertEqual(self.request("/api/v1/preauthkey/expire", {"id": "8"})[0], 200)
        self.assertEqual(Upstream.mutations, [{"id": "8"}])

    def test_package_information_does_not_expose_credentials(self):
        manifest = json.dumps({"version": "0.29.4-3", "secret": "not-for-the-browser"})
        with patch("builtins.open", mock_open(read_data=manifest)), patch.dict(proxy.os.environ, {
            "HEADSCALE_VERSION": "0.29.4", "HEADSCALE_UI_VERSION": "2026.03.17", "OTHER_SECRET": "not-for-the-browser",
        }):
            status, data, headers = self.request("/api/v1/package/info")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"version": "0.29.4-3", "headscaleVersion": "0.29.4", "upstreamUiVersion": "2026.03.17"})
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("/api/v1/package/info", {}, method="POST")[0], 405)

    def test_unknown_or_wrong_user_key_is_not_expired(self):
        for payload in [{"user": "2", "key": "public-prefix-7"}, {"user": "1", "key": "unknown"}]:
            with self.subTest(payload=payload):
                self.assertEqual(self.request("/api/v1/preauthkey/expire", payload)[0], 409)
                self.assertEqual(Upstream.mutations, [])

    def test_missing_zero_boolean_or_invalid_id_is_not_forwarded(self):
        for value in [None, "0", "-1", True, "not-an-id", str(2**64)]:
            with self.subTest(value=value):
                self.assertEqual(self.request("/api/v1/preauthkey/expire", {"id": value})[0], 400)
        self.assertEqual(Upstream.mutations, [])

    def test_filters_keys_for_selected_user(self):
        status, data, headers = self.request("/api/v1/preauthkey?user=1")
        self.assertEqual(status, 200)
        self.assertEqual([key["id"] for key in data["preAuthKeys"]], ["7"])
        self.assertEqual(data["preAuthKeys"][0]["aclTags"], [])
        self.assertEqual(data["preAuthKeys"][0]["expiration"], "2099-01-01T00:00:00.123Z")
        self.assertNotIn("server-only-test-token", json.dumps(data))

    def test_cross_origin_mutation_is_denied(self):
        status, data, _ = self.request("/api/v1/preauthkey/expire", {"id": "7"}, {"Origin": "https://other.example"})
        self.assertEqual(status, 403)
        self.assertIn("message", data)
        self.assertEqual(Upstream.mutations, [])

    def test_missing_origin_and_ui_header_is_denied(self):
        self.assertEqual(self.request("/api/v1/preauthkey/expire", {"id": "7"}, {})[0], 403)

    def test_browser_api_key_creation_is_denied_even_when_encoded(self):
        for path in ["/api/v1/apikey", "/api/v1/%61pikey"]:
            self.assertEqual(self.request(path, {})[0], 403)
        self.assertEqual(Upstream.mutations, [])

    def test_noncanonical_paths_cannot_bypass_api_key_write_restrictions(self):
        for path in ("/api/v1/node/../apikey", "/api/v1/node/%2e%2e/apikey", "/api//v1/apikey"):
            self.assertEqual(self.request(path, {})[0], 400)
        self.assertEqual(Upstream.mutations, [])

    def test_ambiguous_legacy_key_does_not_expire_anything(self):
        duplicate = copy.deepcopy(Upstream.keys[0])
        duplicate["id"] = "9"
        Upstream.keys.append(duplicate)
        self.assertEqual(self.request("/api/v1/preauthkey/expire", {"user": "1", "key": "public-prefix-7"})[0], 409)
        self.assertEqual(Upstream.mutations, [])


if __name__ == "__main__":
    unittest.main()
