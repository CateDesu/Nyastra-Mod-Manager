import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import SevenZip from "node-7z";
import { afterEach, expect, vi } from "vitest";

import { addDialog, closeDialog } from "../../actions/notifications";
import { makeDownload, makeGameStored, makeProfile } from "../../test-utils/builders";
import { test } from "../../test-utils/installManagerTest";
import { UserCanceled } from "../../util/CustomErrors";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

for (const scenario of [
  "unrelated first",
  "selected first",
  "direct",
  "nested",
  "failed removal",
  "stale row",
  "replaced during extraction",
  "Cancel",
] as const) {
  test(`damaged archive deletion preserves owned records: ${scenario}`, async ({
    makeInstallManager,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-archive-delete-"));
    roots.push(root);
    const name = "archive.zip";
    const good = path.join(root, "downloads", "fallout4", name);
    const damaged = path.join(
      root,
      scenario === "direct" || scenario === "nested" ? "incoming" : "downloads/skyrimse",
      name,
    );
    fs.mkdirSync(path.dirname(good), { recursive: true });
    fs.mkdirSync(path.dirname(damaged), { recursive: true });
    const payload = path.join(root, "payload.txt");
    fs.writeFileSync(payload, "unrelated valid archive");
    await new SevenZip().add(good, [payload]);
    const goodBytes = fs.readFileSync(good);
    fs.writeFileSync(damaged, "synthetic unreadable archive");
    const unrelated = makeDownload({
      id: "unrelated",
      game: ["fallout4"],
      localPath: name,
      state: "finished",
      size: goodBytes.length,
    });
    const selected = makeDownload({
      id: "selected",
      game: ["skyrimse"],
      localPath: name,
      state: "finished",
      size: fs.statSync(damaged).size,
    });
    const tracked = scenario !== "direct" && scenario !== "nested";
    const h = makeInstallManager({
      knownGames: [makeGameStored({ id: "skyrimse" }), makeGameStored({ id: "fallout4" })],
      profiles: { p: makeProfile({ id: "p", gameId: "skyrimse" }) },
      activeProfileId: "p",
      downloads: !tracked
        ? { unrelated }
        : scenario === "selected first"
          ? { selected, unrelated }
          : { unrelated, selected },
    });
    h.setState((s) => {
      s.settings.downloads.path = path.join(root, "downloads");
    });
    h.api.lookupModMeta = () => Bluebird.resolve([]);
    const callback = vi.fn();
    if (scenario === "replaced during extraction") {
      const extract = SevenZip.prototype.extractFull;
      vi.spyOn(SevenZip.prototype, "extractFull").mockImplementation(function (...args) {
        return extract.apply(this, args).then((result) => {
          h.setState((s) => {
            s.persistent.downloads.files.selected = makeDownload({
              ...selected,
              fileMD5: "replacement-record",
            });
          });
          return result;
        });
      });
    }
    let installArchive = damaged;
    if (scenario === "nested") {
      installArchive = path.join(root, "outer.zip");
      await new SevenZip().add(installArchive, [damaged]);
      h.manager.addInstaller(
        "synthetic-parent",
        0,
        async () => ({ supported: true, requiredFiles: [] }),
        async (_files, temp) => ({
          instructions: [{ type: "submodule", path: path.join(temp, name) }],
        }),
      );
    }
    try {
      h.manager.install(
        tracked ? "selected" : null,
        installArchive,
        ["skyrimse"],
        h.api,
        { profileId: "p" },
        false,
        false,
        callback,
        "skyrimse",
      );
      await vi.waitFor(
        () => expect(h.dispatched.some((a) => a.type === addDialog.getType())).toBe(true),
        { timeout: 10000 },
      );
      const dialog = h.dispatched.find((a) => a.type === addDialog.getType())!.payload as {
        id: string;
        title: string;
        actions: string[];
      };
      expect(dialog.title).toContain("Archive damaged");
      expect(dialog.actions).toContain("Delete");
      if (scenario === "failed removal") fs.chmodSync(path.dirname(damaged), 0o555);
      if (scenario === "stale row")
        h.setState((s) => {
          s.persistent.downloads.files.selected = makeDownload({
            ...selected,
            fileMD5: "replacement-record",
          });
        });
      h.api.store.dispatch(closeDialog(dialog.id, scenario === "Cancel" ? "Cancel" : "Delete", {}));
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
      expect(callback).toHaveBeenCalledWith(expect.any(UserCanceled), null);
      const preserved = [
        "failed removal",
        "stale row",
        "replaced during extraction",
        "Cancel",
      ].includes(scenario);
      expect(fs.existsSync(damaged)).toBe(preserved || scenario === "nested");
      expect(fs.readFileSync(good)).toEqual(goodBytes);
      expect(h.getState().persistent.downloads.files.unrelated).toEqual(unrelated);
      if (tracked) {
        if (preserved) expect(h.getState().persistent.downloads.files.selected).toBeDefined();
        else expect(h.getState().persistent.downloads.files.selected).toBeUndefined();
      }
      if (scenario === "failed removal" || scenario === "stale row")
        expect(h.errorNotifications).toHaveLength(1);
      if (scenario === "nested") expect(fs.existsSync(installArchive)).toBe(true);
      expect(h.manager.getActiveInstallations()).toEqual([]);
    } finally {
      fs.chmodSync(path.dirname(damaged), 0o755);
    }
  });
}

test("Continue after a recoverable native extraction warning preserves archive records", async ({
  makeInstallManager,
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-archive-continue-"));
  roots.push(root);
  const payload = path.join(root, "payload.txt");
  fs.writeFileSync(payload, "native payload");
  const archive = path.join(root, "downloads", "skyrimse", "archive.zip");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  await new SevenZip().add(archive, [payload]);
  const bytes = fs.readFileSync(archive);
  const h = makeInstallManager({
    knownGames: [makeGameStored()],
    downloads: {
      selected: makeDownload({
        id: "selected",
        localPath: "archive.zip",
        game: ["skyrimse"],
        state: "finished",
      }),
    },
  });
  h.setState((s) => {
    s.settings.downloads.path = path.join(root, "downloads");
  });
  h.manager.addInstaller(
    "synthetic-copy",
    0,
    async () => ({ supported: true, requiredFiles: [] }),
    async () => ({
      instructions: [{ type: "copy", source: "payload.txt", destination: "payload.txt" }],
    }),
  );
  const extract = SevenZip.prototype.extractFull;
  vi.spyOn(SevenZip.prototype, "extractFull").mockImplementation(function (...args) {
    return extract.apply(this, args).then((result) => ({
      ...result,
      code: 1,
      errors: ["Synthetic recoverable warning after native extraction"],
    }));
  });
  const operation = h.manager.simulate(h.api, "skyrimse", archive, path.join(root, "extracted"));
  await vi.waitFor(() =>
    expect(h.dispatched.some((a) => a.type === addDialog.getType())).toBe(true),
  );
  const dialog = h.dispatched.find((a) => a.type === addDialog.getType())!.payload as {
    id: string;
    actions: string[];
  };
  expect(dialog.actions).toContain("Continue");
  h.api.store.dispatch(closeDialog(dialog.id, "Continue", {}));
  expect((await operation).instructions).toEqual([
    { type: "copy", source: "payload.txt", destination: "payload.txt" },
  ]);
  expect(fs.readFileSync(archive)).toEqual(bytes);
  expect(h.getState().persistent.downloads.files.selected).toBeDefined();
});
