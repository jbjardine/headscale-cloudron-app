import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from gateway_settings import DEFAULTS, GatewayManager, validate_settings


class GatewaySettingsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "gateway"
        self.calls = []
        def api(method, path, payload=None):
            self.calls.append((method, path, payload))
            if path.endswith("/user"):
                return {"users": [{"id": "1"}]}
            if path.endswith("/node"):
                return {"nodes": [{"id": "3", "ipAddresses": ["100.64.0.7"]}]}
            return {"preAuthKey": {"key": "test-local-enrollment"}}
        self.manager = GatewayManager(api, "https://headscale.example.test", self.directory)
        self.addCleanup(self.manager.close)
        self.addCleanup(self.temporary.cleanup)

    def settings(self, **changes):
        return {**DEFAULTS, "headscaleUserId": "1", **changes}

    def test_default_is_off_and_does_not_enroll_or_start_any_client(self):
        with patch("gateway_settings.subprocess.Popen") as process:
            self.manager.tick()
        self.assertFalse(self.manager.public()["settings"]["enabled"])
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.calls, [])
        process.assert_not_called()

    def test_secrets_are_private_and_never_returned_in_settings(self):
        key = "tskey-auth-local-dummy-key"
        result = self.manager.save(self.settings(officialAuthKey=key))
        self.assertTrue(result["hasOfficialKey"])
        self.assertNotIn(key, json.dumps(result))
        self.assertNotIn(key, (self.directory / "settings.json").read_text())
        self.assertEqual(os.stat(self.directory).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.directory / "official.key").st_mode & 0o777, 0o600)
        self.manager.save(self.settings())
        self.assertEqual((self.directory / "official.key").read_text(), key)

    def test_enabling_requires_official_key_and_real_user(self):
        with self.assertRaisesRegex(ValueError, "auth key"):
            self.manager.save(self.settings(enabled=True))
        with self.assertRaisesRegex(ValueError, "no longer exists"):
            self.manager.save(self.settings(enabled=True, headscaleUserId="2", officialAuthKey="tskey-auth-dummy"))
        with self.assertRaisesRegex(ValueError, "official Tailscale"):
            self.manager.save(self.settings(officialAuthKey="hskey-auth-dummy"))

    def test_requires_real_selected_headscale_destination(self):
        rule = {"nodeId": "3", "targetIp": "100.64.0.8", "targetPort": 445, "listenPort": 1445}
        with self.assertRaisesRegex(ValueError, "no longer exists"):
            self.manager.save(self.settings(enabled=True, officialAuthKey="tskey-auth-dummy", sourceMode="tailnet", rules=[rule]))

    def test_rejects_public_or_local_destinations_and_invalid_limits(self):
        for address in ("127.0.0.1", "192.168.1.1", "8.8.8.8", "::1", "https://example.test"):
            with self.subTest(address=address), self.assertRaises(ValueError):
                validate_settings(self.settings(rules=[{"nodeId": "3", "targetIp": address, "targetPort": 445, "listenPort": 1445}]))
        for field, value in (("maxConnections", 0), ("maxConnections", True), ("idleTimeoutSeconds", 1), ("maxBytesPerSecond", -1), ("headscaleUserId", "../secret")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_settings(self.settings(**{field: value}))

    def test_sources_and_unique_ports_are_enforced(self):
        rule = {"nodeId": "3", "targetIp": "100.64.0.7", "targetPort": 445, "listenPort": 1445}
        with self.assertRaisesRegex(ValueError, "source"):
            validate_settings(self.settings(enabled=True, rules=[rule]))
        with self.assertRaisesRegex(ValueError, "different"):
            validate_settings(self.settings(rules=[rule, rule]))
        with self.assertRaisesRegex(ValueError, "Tailscale VPN"):
            validate_settings(self.settings(allowedSources=["0.0.0.0/0"]))
        data, _ = validate_settings(self.settings(allowedSources=["100.100.100.1", "100.100.100.1/32"]))
        self.assertEqual(data["allowedSources"], ["100.100.100.1/32"])

    def test_disabling_stops_child_and_preserves_identity(self):
        self.manager.save(self.settings(officialAuthKey="tskey-auth-dummy"))
        process = Mock()
        process.poll.return_value = None
        self.manager.process = process
        self.manager.save(self.settings(enabled=False))
        process.terminate.assert_called_once()
        process.wait.assert_called_once()
        self.assertIsNone(self.manager.process)
        self.assertTrue((self.directory / "official.key").is_file())

    def test_enrollment_is_short_lived_and_reused_after_registration(self):
        self.manager.save(self.settings())
        self.manager.prepare_enrollment(self.settings())
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.calls[0][2]["reusable"])
        self.manager.prepare_enrollment(self.settings())
        self.assertEqual(len(self.calls), 1)
        directory = self.directory / "headscale-1"
        (directory / "tailscaled.state").write_text("local test state")
        (directory / "enrolled").touch()
        os.utime(directory / "enrollment.key", (0, 0))
        self.manager.prepare_enrollment(self.settings())
        self.assertEqual(len(self.calls), 1)

    def test_enrollment_preparation_failure_reports_error_and_retry(self):
        self.manager.save(self.settings(enabled=True, officialAuthKey="tskey-auth-dummy"))
        with patch.object(self.manager, "prepare_enrollment", side_effect=OSError("local API unavailable")), \
             patch("gateway_settings.subprocess.Popen") as process:
            self.manager.tick()
        self.assertEqual(self.manager.public()["status"]["state"], "error")
        self.assertGreater(self.manager.retry_at, 0)
        self.assertIsNone(self.manager.process)
        process.assert_not_called()

    def test_process_start_failure_reports_error_and_successful_retry_recovers(self):
        self.manager.save(self.settings(enabled=True, officialAuthKey="tskey-auth-dummy"))
        with patch("gateway_settings.subprocess.Popen", side_effect=OSError("cannot execute binary")):
            self.manager.tick()
        self.assertEqual(self.manager.public()["status"]["state"], "error")
        child = Mock(); child.poll.return_value = None
        self.manager.retry_at = 0
        with patch("gateway_settings.subprocess.Popen", return_value=child) as process:
            self.manager.tick()
        self.assertEqual(self.manager.public()["status"]["state"], "connecting")
        arguments = process.call_args[0][0]
        self.assertIn("--api-key-file", arguments)
        self.assertNotIn("tskey-auth-dummy", arguments)


if __name__ == "__main__":
    unittest.main()
