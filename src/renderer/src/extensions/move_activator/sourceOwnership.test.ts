import * as fs from "node:fs";
import * as native from "node:fs/promises";
import type * as promises from "node:fs/promises";
import * as path from "node:path";

import { afterEach, expect, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof promises>();
  const wrapped = {
    ...actual,
    link: vi.fn(actual.link),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    copyFile: vi.fn(actual.copyFile),
  };
  return { ...wrapped, default: wrapped };
});

import { makeProfile } from "../../test-utils/builders";
import { test } from "../../test-utils/deploymentTest";
import { getGame } from "../gamemode_management/util/getGame";
import { saveActivation } from "../mod_management/util/activationStore";
import { purgeMods } from "../mod_management/util/deploy";
import * as methods from "../mod_management/util/deploymentMethods";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const failure = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });

for (const scenario of [
  "before claim",
  "after claim",
  "after publication",
  "open writer",
  "collision",
  "copy fallback",
  "copy failure",
  "cleanup failure",
  "unsupported filesystem",
  "rollback collision",
] as const) {
  test(`public Move purge preserves source ownership on ${scenario}`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({
      method: "move",
      files: { "settings.ini": "earlier config" },
      profiles: { p: makeProfile({ id: "p" }) },
      activeProfileId: "p",
      lastActiveProfile: { skyrimse: "p" },
    });
    const manifest = await h.deploy();
    getGame("skyrimse").queryModPath = () => h.gameDir;
    h.setState((state) => {
      state.app = { ...state.app, instanceId: "source-ownership" };
      state.settings.mods.installPath.skyrimse = h.stagingDir;
      state.settings.gameMode.discovered.skyrimse = { path: h.gameDir };
      state.session.base = { ...state.session.base, toolsRunning: {} };
    });
    vi.spyOn(methods, "getActivator").mockReturnValue(h.method);
    vi.spyOn(methods, "getCurrentActivator").mockReturnValue(h.method);
    vi.spyOn(h.api, "emitAndAwait").mockImplementation(async (event, ...args) => {
      await h.emitAndAwait(event, ...args);
      return [];
    });
    await saveActivation(
      "skyrimse",
      "",
      "source-ownership",
      h.gameDir,
      h.stagingDir,
      manifest,
      h.method.id,
    );
    const source = h.inGame("settings.ini");
    const destination = path.join(h.stagingDir, "SomeMod/settings.ini");
    const placeholder = destination + ".vortex_lnk";
    const initial = fs.statSync(source).ino;
    const replace = () => {
      fs.writeFileSync(source + ".replacement", "newer config");
      fs.renameSync(source + ".replacement", source);
      expect(fs.statSync(source).ino).not.toBe(initial);
    };
    const rename = vi.mocked(native.rename).getMockImplementation()!;
    vi.mocked(native.rename).mockImplementation(async (from, to) => {
      if (from === source && scenario === "before claim") replace();
      await rename(from, to);
      if (from === source && scenario === "after claim") replace();
    });
    const link = vi.mocked(native.link).getMockImplementation()!;
    vi.mocked(native.link).mockImplementation(async (from, to) => {
      if (to === destination && (scenario === "copy fallback" || scenario === "copy failure"))
        throw failure("EXDEV");
      if (to === destination && scenario === "collision")
        fs.writeFileSync(destination, "external staged config");
      if (scenario === "unsupported filesystem") throw failure("EPERM");
      if (to === destination && scenario === "rollback collision") {
        replace();
        throw failure("EACCES");
      }
      await link(from, to);
      if (to === destination && scenario === "after publication") replace();
    });
    if (scenario === "copy failure")
      vi.mocked(native.copyFile).mockRejectedValueOnce(failure("EIO"));
    if (scenario === "cleanup failure")
      vi.mocked(native.unlink).mockRejectedValueOnce(failure("EACCES"));
    const fd = ["open writer", "copy fallback", "unsupported filesystem"].includes(scenario)
      ? fs.openSync(source, "r+")
      : undefined;
    try {
      const error = await purgeMods(h.api).then(
        () => undefined,
        (err) => err,
      );
      if (scenario === "unsupported filesystem" || scenario === "rollback collision") {
        expect(error?.code).toBe(scenario === "unsupported filesystem" ? "EBUSY" : "EACCES");
        expect(fs.readFileSync(error.recoveryPath, "utf8")).toBe("earlier config");
        expect(JSON.parse(fs.readFileSync(placeholder, "utf8")).target).toBe(error.recoveryPath);
        if (scenario === "unsupported filesystem") {
          expect(fs.existsSync(source)).toBe(false);
          expect(fs.readFileSync(destination, "utf8")).toBe("earlier config");
          fs.writeSync(fd!, "writer update!", 0, "utf8");
          expect(fs.readFileSync(error.recoveryPath, "utf8")).toBe("writer update!");
          expect(fs.readFileSync(destination, "utf8")).toBe("earlier config");
        } else {
          expect(fs.readFileSync(source, "utf8")).toBe("newer config");
          expect(fs.existsSync(destination)).toBe(false);
          vi.mocked(native.link).mockImplementation(link);
          await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
          expect(fs.readFileSync(source, "utf8")).toBe("newer config");
          expect(fs.readFileSync(destination, "utf8")).toBe("earlier config");
          expect(fs.existsSync(placeholder)).toBe(false);
        }
        return;
      }
      const failed = ["collision", "copy fallback", "copy failure", "cleanup failure"].includes(
        scenario,
      );
      if (failed) {
        expect(error?.code).toBe(
          {
            collision: "EEXIST",
            "copy fallback": "EBUSY",
            "copy failure": "EIO",
            "cleanup failure": "EACCES",
          }[scenario],
        );
        expect(fs.existsSync(placeholder)).toBe(true);
        expect(fs.readFileSync(source, "utf8")).toBe("earlier config");
        const saved = JSON.parse(fs.readFileSync(h.inGame("vortex.deployment.json"), "utf8"));
        expect(saved.files.map((file) => file.relPath)).toEqual(["settings.ini"]);
        if (scenario === "copy failure") expect(fs.existsSync(destination)).toBe(false);
        else
          expect(fs.readFileSync(destination, "utf8")).toBe(
            scenario === "collision" ? "external staged config" : "earlier config",
          );
      } else {
        expect(error).toBeUndefined();
        expect(fs.existsSync(placeholder)).toBe(false);
        expect(fs.readFileSync(destination, "utf8")).toBe(
          scenario === "before claim" ? "newer config" : "earlier config",
        );
        expect(fs.existsSync(source)).toBe(
          scenario === "after claim" || scenario === "after publication",
        );
        if (fs.existsSync(source)) expect(fs.readFileSync(source, "utf8")).toBe("newer config");
      }
      if (fd !== undefined) {
        fs.writeSync(fd, "writer update!", 0, "utf8");
        expect(fs.readFileSync(scenario === "copy fallback" ? source : destination, "utf8")).toBe(
          "writer update!",
        );
        if (scenario === "copy fallback")
          expect(fs.readFileSync(destination, "utf8")).toBe("earlier config");
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
}
