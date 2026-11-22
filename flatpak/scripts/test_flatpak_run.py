import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class FlatpakReinstallTests(unittest.TestCase):
    def exercise(self, failure=None, script="flatpak_run", arguments=None):
        with tempfile.TemporaryDirectory(prefix="nyastra-flatpak-") as root:
            root = Path(root)
            build = root / "build"
            build.mkdir()
            paths = types.SimpleNamespace(
                root=root,
                build_dir=build,
                manifest=root / "manifest",
                repo_dir=root / "repo",
            )
            calls = Mock()
            env = types.ModuleType("_flatpak_env")
            workflow = types.ModuleType("_flatpak_workflow")
            names = [
                "ensure_flathub_remote", "ensure_venv", "run_command",
                "ensure_flatpak_tools", "install_user_app_from_build",
                "is_app_installed", "resolve_flatpak_paths", "run_flatpak_builder",
                "sync_flatpak_build_inputs", "uninstall_user_app",
                "export_build_to_repo", "install_user_app_from_remote",
                "reset_user_remote", "update_user_appstream",
            ]
            for name in names:
                target = env if name in names[:3] else workflow
                setattr(target, name, getattr(calls, name))
            calls.is_app_installed.return_value = True
            calls.resolve_flatpak_paths.return_value = paths
            if failure:
                getattr(calls, failure).side_effect = FileNotFoundError(failure)
            source = Path(__file__).with_name(script + ".py")
            spec = importlib.util.spec_from_file_location(script, source)
            module = importlib.util.module_from_spec(spec)
            with patch.dict(sys.modules, {"_flatpak_env": env, "_flatpak_workflow": workflow}):
                spec.loader.exec_module(module)
            with (
                patch.object(sys, "argv", [script, *(arguments if arguments is not None else ["--reinstall"])]),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                if failure:
                    with self.assertRaises(FileNotFoundError):
                        module.main()
                else:
                    module.main()
            calls.uninstall_user_app.assert_not_called()
            if failure:
                calls.run_command.assert_not_called()
            return calls

    def test_runner_consumes_only_its_argument_separator(self):
        for arguments, forwarded in [
            (["--skip-build", "--", "--user-data", "/disposable/profile", "--", "literal"],
             ["--user-data", "/disposable/profile", "--", "literal"]),
            (["--skip-build", "nxm://game/mods/1"], ["nxm://game/mods/1"]),
            (["--skip-build", "--"], []),
        ]:
            with self.subTest(arguments=arguments):
                calls = self.exercise(arguments=arguments)
                self.assertEqual(
                    calls.run_command.call_args.args[0],
                    ["flatpak", "run", "com.nexusmods.vortex", *forwarded],
                )

    def test_preparation_failures_preserve_existing_installation(self):
        for failure in [
            "sync_flatpak_build_inputs",
            "run_flatpak_builder",
            "install_user_app_from_build",
        ]:
            with self.subTest(failure=failure):
                calls = self.exercise(failure)
                if failure != "install_user_app_from_build":
                    calls.install_user_app_from_build.assert_not_called()

    def test_reinstall_uses_install_transaction_after_build(self):
        calls = self.exercise()
        calls.install_user_app_from_build.assert_called_once()
        self.assertTrue(calls.install_user_app_from_build.call_args.kwargs["reinstall"])
        names = [call[0] for call in calls.mock_calls]
        self.assertLess(names.index("sync_flatpak_build_inputs"), names.index("run_flatpak_builder"))
        self.assertLess(names.index("run_flatpak_builder"), names.index("install_user_app_from_build"))
        self.assertLess(names.index("install_user_app_from_build"), names.index("run_command"))

    def test_install_helper_preserves_install_on_remote_preparation_failure(self):
        self.exercise("reset_user_remote", "flatpak_install")

    def test_workflow_prepares_before_transaction_and_keeps_default_command(self):
        env = types.ModuleType("_flatpak_env")
        env.repo_root = Mock()
        env.run_command = Mock()
        sources = types.ModuleType("flatpak_sources")
        sources.sync_generated_nuget_sources = Mock()
        sources.sync_generated_sources = Mock()
        metainfo = types.ModuleType("update_metainfo_version")
        metainfo.update_metainfo_version = Mock()
        source = Path(__file__).with_name("_flatpak_workflow.py")
        spec = importlib.util.spec_from_file_location("workflow_test", source)
        workflow = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {
            "_flatpak_env": env,
            "flatpak_sources": sources,
            "update_metainfo_version": metainfo,
        }):
            spec.loader.exec_module(workflow)
        with patch.object(workflow, "export_build_to_repo") as export, patch.object(
            workflow, "update_user_appstream"
        ), patch.object(workflow, "reset_user_remote") as remote:
            root = Path("/disposable")
            options = dict(
                root=root, build_dir=root / "build", repo_dir=root / "repo",
                remote_name="local", app_id="com.example.test",
            )
            for operation in [export, remote]:
                operation.side_effect = FileNotFoundError("preparation failed")
                with self.assertRaises(FileNotFoundError):
                    workflow.install_user_app_from_build(**options, reinstall=True)
                env.run_command.assert_not_called()
                operation.side_effect = None
            for reinstall in [False, True]:
                workflow.install_user_app_from_build(**options, reinstall=reinstall)
                expected = ["flatpak", "install", "--user", "-y"]
                if reinstall:
                    expected.append("--reinstall")
                env.run_command.assert_called_with(
                    [*expected, "local", "com.example.test"], cwd=root
                )


@unittest.skipUnless(shutil.which("flatpak") and shutil.which("ostree"), "Flatpak and OSTree required")
class FlatpakRemoteTests(unittest.TestCase):
    app_id = "com.example.NyastraRegression"
    remote = "regression-local"

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="nyastra-flatpak-remote-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        isolated = {
            "HOME": "home", "XDG_DATA_HOME": "data", "XDG_CONFIG_HOME": "config",
            "XDG_CACHE_HOME": "cache", "XDG_RUNTIME_DIR": "run",
            "FLATPAK_USER_DIR": "installation", "FLATPAK_SYSTEM_DIR": "system",
            "XDG_DATA_DIRS": "system-data", "XDG_CONFIG_DIRS": "system-config",
            "FLATPAK_CONFIG_DIR": "flatpak-config",
        }
        environment = {key: str(self.root / directory) for key, directory in isolated.items()}
        for directory in environment.values():
            Path(directory).mkdir(mode=0o700, parents=True)
        environment["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + str(self.root / "no-session-bus")
        environment["GIO_USE_VFS"] = "local"
        environment["LC_ALL"] = "C"
        settings = patch.dict(os.environ, environment)
        settings.start()
        self.addCleanup(settings.stop)
        source = Path(__file__).with_name("_flatpak_workflow.py")
        spec = importlib.util.spec_from_file_location("remote_workflow_test", source)
        self.workflow = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.workflow)
        self.repo = self.root / "repo"
        self.build = self.root / "build"
        self.arch = self.command("flatpak", "--default-arch").stdout.strip()
        (self.build / "files/bin").mkdir(parents=True)
        (self.build / "files/bin/noop").write_text("#!/bin/sh\nexit 0\n")
        (self.build / "metadata").write_text(
            "[Application]\nname=" + self.app_id + "\n"
            f"runtime=org.example.TestRuntime/{self.arch}/stable\n"
            f"sdk=org.example.TestRuntime/{self.arch}/stable\ncommand=noop\n"
        )
        self.command("flatpak", "build-finish", str(self.build))
        self.command("flatpak", "build-export", str(self.repo), str(self.build))

    def command(self, *args, check=True):
        return subprocess.run(args, capture_output=True, text=True, check=check, timeout=30)

    def install(self):
        self.command("flatpak", "remote-add", "--user", "--no-gpg-verify", self.remote, str(self.repo))
        self.command(
            "flatpak", "install", "--user", "-y", "--no-deps", "--no-related",
            self.remote, self.app_id,
        )

    def installed_commit(self):
        return self.command("flatpak", "info", "--user", "--show-commit", self.app_id).stdout.strip()

    def add_runtime(self):
        runtime = self.root / "runtime"
        (runtime / "usr").mkdir(parents=True)
        (runtime / "files").mkdir()
        (runtime / "metadata").write_text(
            "[Runtime]\nname=org.example.TestRuntime\n"
            f"runtime=org.example.TestRuntime/{self.arch}/stable\n"
            f"sdk=org.example.TestRuntime/{self.arch}/stable\n"
        )
        self.command("flatpak", "build-finish", str(runtime))
        self.command("flatpak", "build-export", "--runtime", str(self.repo), str(runtime), "stable")
        self.command("flatpak", "install", "--user", "-y", self.remote, "org.example.TestRuntime")

    def test_remote_can_be_created_and_reused(self):
        self.workflow.reset_user_remote(self.remote, self.repo)
        self.workflow.reset_user_remote(self.remote, self.repo)
        result = self.command("flatpak", "remote-list", "--user", "--columns=name,url")
        self.assertIn(self.remote, result.stdout)
        self.assertIn(
            [self.remote, self.repo.resolve().as_uri()],
            [line.split("\t") for line in result.stdout.splitlines()],
        )
        self.assertIn(self.app_id, self.command("flatpak", "remote-ls", "--user", self.remote).stdout)

    @unittest.skipIf(os.geteuid() == 0, "Requires native permission failures")
    def test_remote_write_failure_is_reported_and_keeps_existing_program(self):
        self.install()
        original = self.installed_commit()
        repository = self.root / "installation/repo"
        previous_mode = repository.stat().st_mode & 0o777
        try:
            repository.chmod(0o555)
            with self.assertRaises(subprocess.CalledProcessError):
                self.workflow.reset_user_remote(self.remote, self.repo)
        finally:
            repository.chmod(previous_mode)
        self.assertEqual(self.installed_commit(), original)
        self.workflow.reset_user_remote(self.remote, self.repo)
        self.assertIn(self.app_id, self.command("flatpak", "remote-ls", "--user", self.remote).stdout)

    def test_in_use_remote_is_updated_without_removing_installed_refs(self):
        self.install()
        original = self.installed_commit()
        deletion = self.command("flatpak", "remote-delete", "--user", self.remote, check=False)
        self.assertNotEqual(deletion.returncode, 0)
        self.assertIn("installed refs", deletion.stderr)
        replacement = self.root / "replacement"
        self.command("flatpak", "build-export", str(replacement), str(self.build))
        self.workflow.reset_user_remote(self.remote, replacement)
        self.assertEqual(self.installed_commit(), original)
        self.assertIn(self.app_id, self.command("flatpak", "remote-ls", "--user", self.remote).stdout)
        result = self.command("flatpak", "remote-list", "--user", "--columns=name,url")
        self.assertIn(
            [self.remote, replacement.resolve().as_uri()],
            [line.split("\t") for line in result.stdout.splitlines()],
        )
        self.workflow.reset_user_remote(self.remote, replacement)
        self.assertEqual(self.installed_commit(), original)

    def test_reinstall_replaces_existing_program_from_new_repository(self):
        self.install()
        self.add_runtime()
        original = self.installed_commit()
        (self.build / "files/bin/noop").write_text("#!/bin/sh\nexit 42\n")
        replacement = self.root / "replacement repository"
        self.command("flatpak", "build-export", "--runtime", str(replacement), str(self.root / "runtime"), "stable")
        self.workflow.install_user_app_from_build(
            root=self.root, build_dir=self.build, repo_dir=replacement,
            remote_name=self.remote, app_id=self.app_id, reinstall=True,
        )
        self.assertNotEqual(self.installed_commit(), original)
        location = self.command("flatpak", "info", "--user", "--show-location", self.app_id).stdout.strip()
        self.assertEqual((Path(location) / "files/bin/noop").read_text(), "#!/bin/sh\nexit 42\n")
        self.assertEqual(self.command("flatpak", "info", "--user", "--show-origin", self.app_id).stdout.strip(), self.remote)

    def test_failed_replacement_preserves_existing_program_and_can_retry(self):
        self.install()
        self.add_runtime()
        original = self.installed_commit()
        replacement = self.root / "missing repository"
        self.workflow.reset_user_remote(self.remote, replacement)
        with self.assertRaises(SystemExit):
            self.workflow.install_user_app_from_remote(
                root=self.root, remote_name=self.remote, app_id=self.app_id, reinstall=True,
            )
        self.assertEqual(self.installed_commit(), original)
        self.workflow.reset_user_remote(self.remote, self.repo)
        self.workflow.install_user_app_from_remote(
            root=self.root, remote_name=self.remote, app_id=self.app_id, reinstall=True,
        )
        self.assertEqual(self.installed_commit(), original)


if __name__ == "__main__":
    unittest.main()
