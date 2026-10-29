import * as fs from "node:fs/promises";
import * as path from "node:path";

import { expect, vi } from "vitest";

import {
  makeDownload,
  makeDriverHarness,
  makeMod,
  makeProfile,
  makeRule,
} from "../../../test-utils/builders";
import { test } from "../../../test-utils/deploymentTest";
import getNormalizeFunc from "../../../util/getNormalizeFunc";
import { getGame } from "../../gamemode_management/util/getGame";
import deployMods from "../../mod_management/modActivation";
import BlacklistSet from "../../mod_management/util/BlacklistSet";
import InstallDriver from "./InstallDriver";

for (const patchFirst of [true, false]) {
  test(`collection deployment waits for patched member bytes, patch first=${patchFirst}`, async ({
    makeDeployment,
  }) => {
    const dep = makeDeployment({ files: { "config.bin": "original" }, modName: "member" });
    const profile = makeProfile({ id: "patch-profile" });
    const rule = makeRule({
      reference: { tag: "patched-member", description: "Member" },
      extra: { patches: { "config.bin": "2F727085" } },
    });
    const collection = makeMod({
      id: "collection",
      installationPath: "collection",
      archiveId: "archive",
      type: "collection",
      rules: [rule],
    });
    const member = makeMod({
      id: "member",
      installationPath: "member",
      attributes: { referenceTag: "patched-member" },
    });
    const download = makeDownload({ id: "archive", state: "finished", modInfo: {} });
    const h = makeDriverHarness(InstallDriver, {
      installPath: { skyrimse: dep.stagingDir },
      mods: { skyrimse: { collection } },
      downloads: { archive: download },
      profiles: { [profile.id]: profile },
    });
    const patchDirectory = path.join(dep.stagingDir, "collection", "patches", "Member");
    await fs.mkdir(patchDirectory, { recursive: true });
    await fs.writeFile(path.join(patchDirectory, "config.bin.diff"), "worker fixture");
    await fs.writeFile(
      path.join(dep.stagingDir, "collection", "collection.json"),
      JSON.stringify({
        info: {
          author: "Fixture",
          authorUrl: "",
          name: "Fixture",
          description: "",
          domainName: "skyrimspecialedition",
          gameVersions: [],
        },
        mods: [],
        modRules: [],
      }),
    );
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const priorApi = window.api;
    const worker = vi.fn(async (_source: string, output: string) => {
      entered();
      await gate;
      await fs.writeFile(output, "patched member");
    });
    window.api = { ...priorApi, bsdiff: { ...priorApi.bsdiff, patch: worker } };
    const normalize = await getNormalizeFunc(dep.gameDir);
    const deploy = vi.fn(async (cb: (error: unknown) => void) => {
      try {
        await deployMods(
          dep.api,
          "skyrimse",
          dep.stagingDir,
          dep.gameDir,
          [member],
          dep.method,
          [],
          "",
          new BlacklistSet([], getGame("skyrimse"), normalize),
          () => "",
        );
        cb(null);
      } catch (error) {
        cb(error);
      }
    });
    h.api.events.on("deploy-mods", deploy);
    let completed = false;
    h.api.events.on("collection-postprocess-complete", () => {
      completed = true;
    });
    let phase: Promise<void>;
    try {
      await h.driver.start(profile, collection);
      h.setState((draft) => {
        draft.persistent.mods.skyrimse.member = member;
        for (const value of Object.values(draft.session.collections.activeSession.mods))
          value.status = "installed";
      });
      h.emit("did-install-mod", "skyrimse", "member-archive", "member");
      await started;
      if (patchFirst) {
        release();
        await vi.waitFor(async () =>
          expect(await fs.readFile(path.join(dep.stagingDir, "member", "config.bin"), "utf8")).toBe(
            "patched member",
          ),
        );
      }
      let phaseFinished = false;
      phase = h.emitAndAwait("will-deploy", profile.id).then(() => {
        phaseFinished = true;
      });
      h.emit("did-install-dependencies", "skyrimse", "collection", false);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (!patchFirst) {
        expect(phaseFinished).toBe(false);
        expect(completed).toBe(false);
        expect(deploy).not.toHaveBeenCalled();
      }
      release();
      await phase;
      await vi.waitFor(() => expect(completed).toBe(true));
      expect(await fs.readFile(path.join(dep.stagingDir, "member", "config.bin"), "utf8")).toBe(
        "patched member",
      );
      expect(await fs.readFile(path.join(dep.gameDir, "config.bin"), "utf8")).toBe(
        "patched member",
      );
      expect(h.errorNotifications).toEqual([]);
    } finally {
      release();
      await phase;
      await vi.waitFor(async () =>
        expect(await fs.readFile(path.join(dep.stagingDir, "member", "config.bin"), "utf8")).toBe(
          "patched member",
        ),
      );
      window.api = priorApi;
    }
  });
}
