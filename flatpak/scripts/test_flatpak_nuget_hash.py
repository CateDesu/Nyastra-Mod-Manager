import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from _flatpak_nuget_hash import collect_nuget_input_files


class NuGetPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.source = self.root / "extensions"
        self.source.mkdir()
        self.project = self.source / "fixture.csproj"
        self.project.write_text("<Project/>")
        self.outside = Path(self.temp.name) / "outside"
        self.outside.mkdir()
        (self.outside / "external.csproj").write_text("<Project/>")
        patcher = patch("_flatpak_nuget_hash.repo_root", return_value=self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_collects_repository_inputs(self):
        self.assertEqual(collect_nuget_input_files(Path("extensions")), [self.project])

    def test_rejects_external_roots_before_walking(self):
        for root in [self.outside, Path("../outside")]:
            with self.subTest(root=root), self.assertRaises(ValueError):
                collect_nuget_input_files(root)

    def test_rejects_linked_roots_and_input_files_outside_the_repository(self):
        linked = self.root / "linked"
        linked.symlink_to(self.outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            collect_nuget_input_files(linked)
        (self.source / "linked.csproj").symlink_to(self.outside / "external.csproj")
        with self.assertRaises(ValueError):
            collect_nuget_input_files(self.source)


if __name__ == "__main__":
    unittest.main()
