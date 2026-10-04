import importlib.util
from pathlib import Path
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("derp_config", ROOT / "derp_config.py")
derp_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(derp_config)


class DERPConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "config.yaml"
        self.map = str(Path(self.temp.name) / "runtime-map.yaml")
        self.config = {"server_url": "https://headscale.example.org", "derp": {
            "server": {"enabled": True, "region_id": 999, "verify_clients": True,
                       "stun_listen_addr": "0.0.0.0:3478", "automatically_add_embedded_derp_region": True},
            "paths": ["/app/data/another-region.yaml"], "urls": ["https://controlplane.tailscale.com/derpmap/default"]}}
        self.write()

    def write(self):
        self.path.write_text(yaml.safe_dump(self.config))

    def configure(self, port):
        return derp_config.configure(self.path, port, self.map)

    def node(self):
        return yaml.safe_load(Path(self.map).read_text())["regions"][999]["nodes"][0]

    def test_external_port_is_advertised_while_listener_and_verification_remain(self):
        original = self.path.read_bytes()
        self.assertTrue(self.configure("3479"))
        self.assertEqual(self.node()["stunport"], 3479)
        self.assertEqual(self.node()["hostname"], "headscale.example.org")
        self.assertEqual(self.node()["derpport"], 443)
        saved = yaml.safe_load(self.path.read_text())
        self.assertEqual(saved["derp"]["server"]["stun_listen_addr"], "0.0.0.0:3478")
        self.assertTrue(saved["derp"]["server"]["verify_clients"])
        self.assertEqual(saved["derp"]["paths"], ["/app/data/another-region.yaml", self.map])
        self.assertEqual(self.path.with_name("config.yaml.before-cloudron-derp").read_bytes(), original)
        self.configure("41000")
        self.assertEqual(self.node()["stunport"], 41000)
        self.assertEqual(self.path.with_name("config.yaml.before-cloudron-derp").read_bytes(), original)

    def test_runtime_map_is_recreated_after_restart(self):
        self.configure("3479")
        Path(self.map).unlink()
        self.configure("3479")
        self.assertEqual(self.node()["stunport"], 3479)

    def test_disabling_derp_removes_runtime_path(self):
        self.configure("3479")
        self.config = yaml.safe_load(self.path.read_text())
        self.config["derp"]["server"]["enabled"] = False
        self.write()
        Path(self.map).unlink()
        self.assertFalse(self.configure("3479"))
        self.assertNotIn(self.map, yaml.safe_load(self.path.read_text())["derp"]["paths"])

    def test_explicit_custom_map_is_preserved(self):
        self.config["derp"]["server"]["automatically_add_embedded_derp_region"] = False
        self.write()
        original = self.path.read_bytes()
        self.assertFalse(self.configure("3479"))
        self.assertEqual(self.path.read_bytes(), original)

    def test_no_cloudron_mapping_leaves_direct_install_unchanged(self):
        original = self.path.read_bytes()
        self.assertFalse(self.configure(None))
        self.assertEqual(self.path.read_bytes(), original)
        self.configure("3479")
        self.configure(None)
        self.assertEqual(self.node()["stunport"], 3478)

    def test_disabled_external_udp_is_not_advertised(self):
        self.configure("0")
        self.assertEqual(self.node()["stunport"], -1)

    def test_invalid_port_is_rejected_without_changing_configuration(self):
        original = self.path.read_bytes()
        for port in ("-1", "65536", "not-a-port"):
            with self.assertRaises(ValueError):
                self.configure(port)
        self.assertEqual(self.path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
