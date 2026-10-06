"""Exercise installation against disposable homes, never the real user home."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="skills install ")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo with spaces"
        self.home = Path(self.temp.name) / "test home"
        (self.repo / "scripts").mkdir(parents=True)
        self.source = self.repo / "example-skill"
        self.source.mkdir()
        (self.source / "SKILL.md").write_text("---\nname: example-skill\ndescription: Example\n---\n")
        shutil.copy2(ROOT / "install.sh", self.repo / "install.sh")
        shutil.copy2(ROOT / "scripts/install.py", self.repo / "scripts/install.py")
        self.targets = [self.home / p / "skills/example-skill" for p in (".agents", ".claude")]

    def run_install(self, *args):
        return subprocess.run(["bash", str(self.repo / "install.sh"), "--home", str(self.home), *args], capture_output=True, text=True)

    def test_install_and_repeat_preserve_existing_skills(self):
        unrelated = self.home / ".agents/skills/keep/SKILL.md"
        unrelated.parent.mkdir(parents=True)
        unrelated.write_text("preserve me")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        for target in self.targets:
            self.assertTrue(target.is_symlink())
            self.assertEqual(target.resolve(), self.source.resolve())
        before = [target.lstat().st_ino for target in self.targets]
        self.assertEqual(self.run_install().returncode, 0)
        self.assertEqual(before, [target.lstat().st_ino for target in self.targets])
        self.assertEqual(unrelated.read_text(), "preserve me")
        self.assertEqual(self.run_install("--check").returncode, 0)

    def test_check_and_dry_run_do_not_create_home(self):
        self.assertEqual(self.run_install("--check").returncode, 1)
        self.assertEqual(self.run_install("--dry-run").returncode, 0)
        self.assertFalse(self.home.exists())

    def test_conflict_does_not_partially_install(self):
        target = self.targets[1]
        target.parent.mkdir(parents=True)
        target.write_text("existing skill")
        self.assertEqual(self.run_install().returncode, 1)
        self.assertEqual(target.read_text(), "existing skill")
        self.assertFalse(os.path.lexists(self.targets[0]))

    def test_wrong_and_dangling_symlinks_are_preserved(self):
        target = self.targets[1]
        target.parent.mkdir(parents=True)
        for name, exists in [("other", True), ("missing", False)]:
            with self.subTest(name=name):
                other = Path(self.temp.name) / name
                if exists:
                    other.mkdir()
                target.symlink_to(other, target_is_directory=True)
                self.assertEqual(self.run_install().returncode, 1)
                self.assertEqual(target.readlink(), other)
                self.assertFalse(os.path.lexists(self.targets[0]))
                target.unlink()

    def test_file_blocking_a_parent_is_preserved(self):
        self.home.mkdir()
        blocker = self.home / ".claude"
        blocker.write_text("keep")
        self.assertEqual(self.run_install().returncode, 1)
        self.assertEqual(blocker.read_text(), "keep")
        self.assertFalse((self.home / ".agents").exists())


if __name__ == "__main__":
    unittest.main()
