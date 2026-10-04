import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("publication", ROOT / "scripts/publication_bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class PublicationBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        for name in (*bundle.RELEASE_FILES, "gateway/main.go", "scripts/do-not-execute.py"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original\n")
        manifest = {"id": "io.github.jbjardine.headscale-cloudron-app", "version": "0.29.4-2"}
        catalog = {"versions": {"0.29.4-2": {"publishState": "published", "manifest": {"version": "0.29.4-2", "dockerImage": bundle.IMAGE + ":v0.29.4-2"}}}}
        (self.root / "CloudronManifest.json").write_text(json.dumps(manifest))
        (self.root / "CloudronVersions.json").write_text(json.dumps(catalog))
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], cwd=self.root, check=True)
        (self.root / "dist").mkdir()
        (self.root / bundle.NOTES).write_text("release notes\n")
        self.snapshot = Path(self.temp.name) / "snapshot.tar.gz"

    def freeze(self):
        return bundle.freeze(self.root, self.snapshot, generated=True, notes=True)

    def test_post_snapshot_changes_cannot_reach_publication(self):
        digest = self.freeze()
        (self.root / "Dockerfile").write_text("malicious later edit\n")
        (self.root / "gateway/main.go").write_text("malicious later edit\n")
        (self.root / bundle.NOTES).write_text("malicious later notes\n")
        destination = Path(self.temp.name) / "published"
        checkout = Path(self.temp.name) / "trusted-checkout"
        bundle.publication_data(self.snapshot, digest, "v0.29.4-2", destination, copy_to=checkout)
        self.assertEqual((checkout / "Dockerfile").read_text(), "original\n")
        self.assertFalse((checkout / "gateway/main.go").exists())
        self.assertEqual((destination / "release-notes.md").read_text(), "release notes\n")
        with tarfile.open(destination / "headscale-cloudron-app-v0.29.4-2.tar.gz") as archive:
            self.assertEqual(archive.extractfile("./gateway/main.go").read(), b"original\n")
            self.assertFalse(any(".github/" in item.name or "dist/" in item.name for item in archive))

    def test_changed_snapshot_is_rejected(self):
        digest = self.freeze()
        with self.snapshot.open("ab") as handle:
            handle.write(b"tampered")
        with self.assertRaisesRegex(ValueError, "digest"):
            bundle.publication_data(self.snapshot, digest, "v0.29.4-2", Path(self.temp.name) / "published")

    def test_updater_cannot_modify_first_party_source(self):
        (self.root / "gateway/main.go").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "allowlist"):
            self.freeze()

    def test_updater_cannot_add_a_source_file(self):
        (self.root / "new-code.py").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "untracked"):
            self.freeze()

    def test_archive_links_and_traversal_are_rejected(self):
        for name, kind in (("../outside", tarfile.REGTYPE), ("link", tarfile.SYMTYPE)):
            with self.subTest(name=name):
                with tarfile.open(self.snapshot, "w:gz") as archive:
                    item = tarfile.TarInfo(name)
                    item.type = kind
                    item.linkname = "outside"
                    archive.addfile(item, io.BytesIO(b""))
                with self.assertRaisesRegex(ValueError, "invalid entry"):
                    bundle.unpack(self.snapshot, bundle.sha256(self.snapshot), Path(self.temp.name) / "extracted")

    def test_catalog_must_match_release_tag(self):
        catalog = json.loads((self.root / "CloudronVersions.json").read_text())
        catalog["versions"]["0.29.4-2"]["publishState"] = "testing"
        (self.root / "CloudronVersions.json").write_text(json.dumps(catalog))
        digest = self.freeze()
        with self.assertRaisesRegex(ValueError, "catalog mismatch"):
            bundle.publication_data(self.snapshot, digest, "v0.29.4-2", Path(self.temp.name) / "published")


if __name__ == "__main__":
    unittest.main()
