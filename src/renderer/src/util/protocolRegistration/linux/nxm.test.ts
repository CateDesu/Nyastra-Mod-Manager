import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ directory: "", setDefault: vi.fn(), refresh: vi.fn() }));
vi.mock("./common", () => ({
  applicationsDirectory: () => state.directory,
  getDefaultUrlSchemeHandler: () => undefined,
  setDefaultUrlSchemeHandler: state.setDefault,
  refreshDesktopDatabase: state.refresh,
}));
vi.mock("../../log", () => ({ log: vi.fn() }));
import { registerLinuxNxmProtocolHandler } from "./nxm";
let root: string;
let executable: string;
let appPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-desktop-"));
  state.directory = path.join(root, "applications");
  fs.mkdirSync(state.directory);
  executable = path.join(root, "Astra's $ Linux.AppImage");
  fs.writeFileSync(
    executable,
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.NYASTRA_LAUNCH_RECORD, JSON.stringify(process.argv.slice(2)));\n',
    { mode: 0o755 },
  );
  appPath = path.join(root, "app.asar");
  fs.mkdirSync(path.join(appPath, "assets/images"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "assets/images/nyastra.png"), "mascot");
  state.setDefault.mockReset().mockReturnValue(true);
  state.refresh.mockReset();
  vi.stubEnv("APPIMAGE", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("IS_FLATPAK", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
describe("Linux package download-link registration", () => {
  it.runIf(process.platform === "linux").each(["Astra's", "100%cat", "100% cat's%u"])(
    "launches a generated desktop entry through GIO in %s",
    async (directory) => {
      state.directory = path.join(root, directory);
      fs.mkdirSync(state.directory);
      vi.stubEnv("APPIMAGE", executable);
      registerLinuxNxmProtocolHandler({ setAsDefault: false, executablePath: executable, appPath });
      const record = path.join(root, "record.json");
      const url = "nxm://re9/mods/1/files/2?key=AbC%2BDef&expires=42";

      const run = spawnSync(
        "gio",
        ["launch", path.join(state.directory, "io.github.CateDesu.NyastraModManager.desktop"), url],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_STATE_HOME: path.join(root, "state"),
            NYASTRA_LAUNCH_RECORD: record,
          },
        },
      );

      expect(run.status, run.stderr).toBe(0);
      await vi.waitFor(() => {
        expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual(["--install", url]);
      });
      expect(state.setDefault).not.toHaveBeenCalled();
    },
  );

  it("uses a stable AppImage path and preserves URL bytes through its shell wrapper", () => {
    vi.stubEnv("APPIMAGE", executable);
    expect(
      registerLinuxNxmProtocolHandler({
        setAsDefault: true,
        executablePath: "/tmp/.mount_gone/program",
        appPath,
      }),
    ).toBe(true);
    const wrapper = path.join(state.directory, "io.github.CateDesu.NyastraModManager.desktop.sh");
    const record = path.join(root, "record.json"),
      url = "nxm://re9/mods/1/files/2?key=AbC%2BDef&expires=42";
    const run = spawnSync("sh", [wrapper, url], {
      env: { ...process.env, NYASTRA_LAUNCH_RECORD: record },
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual(["--install", url]);
    expect(
      spawnSync("sh", [wrapper], { env: { ...process.env, NYASTRA_LAUNCH_RECORD: record } }).status,
    ).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual([]);
    expect(
      fs.readFileSync(
        path.join(state.directory, "io.github.CateDesu.NyastraModManager.png"),
        "utf8",
      ),
    ).toBe("mascot");
  });
  it("selects the desktop ID actually installed by the Debian package", () => {
    const entry = path.join(state.directory, "nyastra-mod-manager.desktop");
    fs.writeFileSync(entry, "installed entry");
    registerLinuxNxmProtocolHandler({ setAsDefault: true, executablePath: executable, appPath });
    expect(state.setDefault).toHaveBeenCalledWith("nxm", "nyastra-mod-manager.desktop");
    expect(fs.readFileSync(entry, "utf8")).toBe("installed entry");
  });
  it("reports a desktop command failure instead of claiming success", () => {
    state.setDefault.mockReturnValue(false);
    expect(() =>
      registerLinuxNxmProtocolHandler({ setAsDefault: true, executablePath: executable, appPath }),
    ).toThrow("registration failed");
  });
  it("leaves the association alone when handling links is disabled", () => {
    expect(
      registerLinuxNxmProtocolHandler({ setAsDefault: false, executablePath: executable, appPath }),
    ).toBe(false);
    expect(state.setDefault).not.toHaveBeenCalled();
  });
});
