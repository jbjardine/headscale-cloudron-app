import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("updater", ROOT / "scripts/autoupdate_upstream.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class AutoupdateTests(unittest.TestCase):
    def test_version_numbers_do_not_collide_and_downgrades_stop(self):
        self.assertEqual(updater.next_package_version("0.29.4-1", "0.29.4", {"0.29.4-2": {}}), "0.29.4-3")
        self.assertEqual(updater.next_package_version("0.29.4-1", "0.30.0", {}), "0.30.0-1")
        with self.assertRaisesRegex(SystemExit, "downgrade"):
            updater.refuse_downgrade("Headscale", "0.29.4", "0.29.3")

    def test_pending_package_is_prepared_once_and_published_version_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {name: root / path.relative_to(ROOT) for name, path in
                     (("DOCKERFILE", updater.DOCKERFILE), ("MANIFEST", updater.MANIFEST), ("VERSIONS", updater.VERSIONS),
                      ("CHANGELOG", updater.CHANGELOG), ("README", updater.README), ("STATE", updater.STATE))}
            for name, path in paths.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(getattr(updater, name).read_bytes())
            gateway = root / "gateway"
            gateway.mkdir()
            (gateway / "go.mod").write_bytes((ROOT / "gateway/go.mod").read_bytes())
            state = json.loads(paths["STATE"].read_text())
            _, docker = updater.parse_dockerfile()
            manifest = json.loads(paths["MANIFEST"].read_text())
            versions = json.loads(paths["VERSIONS"].read_text())
            versions["versions"][manifest["version"]]["publishState"] = "testing"
            paths["VERSIONS"].write_text(json.dumps(versions))
            original_changelog = paths["CHANGELOG"].read_text()
            with patch.multiple(updater, ROOT=root, GATEWAY=gateway, RELEASE_NOTES=root / "dist/release-notes.md", **paths), \
                 patch.object(updater, "headscale_latest", return_value={"version": docker["headscale_version"], "sha256": docker["headscale_sha256"]}), \
                 patch.object(updater, "headscale_ui_latest", return_value={"version": docker["headscale_ui_version"], "sha256": docker["headscale_ui_sha256"]}), \
                 patch.object(updater, "tailscale_latest", return_value={"version": state["tailscale_version"], "go_version": "1.26.6"}), \
                 patch.object(updater, "latest_alpine_tag", return_value=docker["alpine"]), \
                 patch.object(updater, "alpine_digest", return_value=state["alpine_digest"]), \
                 patch("sys.argv", ["autoupdate", "--github-output", str(root / "outputs")]):
                self.assertEqual(updater.main(), 0)
                self.assertIn("changed=true", (root / "outputs").read_text())
                published = json.loads(paths["VERSIONS"].read_text())
                self.assertEqual(published["versions"][manifest["version"]]["publishState"], "published")
                self.assertEqual(json.loads(paths["MANIFEST"].read_text())["version"], manifest["version"])
                self.assertEqual(paths["CHANGELOG"].read_text().count("## " + manifest["version"]), original_changelog.count("## " + manifest["version"]))
                saved = {name: path.read_bytes() for name, path in paths.items()}
                (root / "outputs").write_text("")
                self.assertEqual(updater.main(), 0)
                self.assertIn("changed=false", (root / "outputs").read_text())
                self.assertEqual(saved, {name: path.read_bytes() for name, path in paths.items()})

    def test_no_releases_are_accepted_from_a_prerelease_response(self):
        with patch.object(updater, "request_json", return_value={"prerelease": True, "draft": False}):
            with self.assertRaisesRegex(SystemExit, "prerelease"):
                updater.latest_github_release("example/repository")


if __name__ == "__main__":
    unittest.main()
