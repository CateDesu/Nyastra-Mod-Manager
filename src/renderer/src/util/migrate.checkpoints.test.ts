import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import Zip from "node-7z";
import { expect, test, vi } from "vitest";

import { IPCDownloadAdapter } from "../IPCDownloadAdapter";
import { appReducer } from "../reducers/app";
import { downloadsReducer } from "../reducers/downloads";
import { makeApiHarness, makeDownload, makeGameStored, makeProfile } from "../test-utils/builders";
import currentMigrate from "./migrate";

const transport = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock("../../../main/src/ipc", () => ({
  betterIpcMain: { handle: (key: string, fn: (...args: any[]) => any) => transport.set(key, fn) },
}));
vi.mock("../../../main/src/logging", () => ({ log: vi.fn() }));

for (const occupied of [0, 1, 3]) {
  test(`domain migration resumes the exact native archive with ${occupied} collisions`, async () => {
    const main = path.resolve(__dirname, "../../../main/src/downloading");
    const { DownloadManager } = await import(/* @vite-ignore */ `${main}/manager.ts`);
    const { init } = await import(/* @vite-ignore */ `${main}/ipc.ts`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "round3-migration-checkpoint-"));
    const source = path.join(root, "downloads", "skyrimspecialedition", "archive.zip");
    const moved = path.join(
      root,
      "downloads",
      "skyrimse",
      occupied === 0 ? "archive.zip" : `archive.${occupied}.zip`,
    );
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    const unrelated = new Map<string, Buffer>();
    for (let i = 0; i < occupied; i++) {
      const filename = path.join(path.dirname(moved), i === 0 ? "archive.zip" : `archive.${i}.zip`);
      const bytes = Buffer.from(`unrelated archive ${i}`);
      fs.writeFileSync(filename, bytes);
      unrelated.set(filename, bytes);
    }
    const input = path.join(root, "payload.txt");
    fs.writeFileSync(input, "complete synthetic migration payload");
    const complete = path.join(root, "complete.zip");
    await new Zip().add(complete, [input]);
    const body = fs.readFileSync(complete);
    const prefix = body.subarray(0, Math.floor(body.length / 2));
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, prefix);
    const ranges: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.headers.range) ranges.push(req.headers.range);
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      const start = range ? +range[1] : 0,
        end = range ? +range[2] : body.length - 1;
      res.writeHead(range ? 206 : 200, {
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
        etag: '"fixture"',
        ...(range ? { "content-range": `bytes ${start}-${end}/${body.length}` } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : body.subarray(start, end + 1));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/archive.zip`;
    const h = makeApiHarness(
      {
        profiles: { p: makeProfile({ id: "p", gameId: "skyrimse" }) },
        activeProfileId: "p",
        downloads: {
          old: makeDownload({
            id: "old",
            game: ["skyrimspecialedition"],
            state: "paused",
            localPath: "archive.zip",
            received: prefix.length,
            size: body.length,
            urls: [url],
          }),
        },
      },
      [
        { path: ["persistent", "downloads"], reducer: downloadsReducer },
        { path: ["app"], reducer: appReducer },
      ],
    );
    h.setState((s) => {
      s.settings.downloads.path = path.join(root, "downloads");
      s.session.gameMode.known = [
        makeGameStored({ id: "skyrimse", details: { nexusPageId: "skyrimspecialedition" } }),
      ];
      s.app.appVersion = "2.1.0-beta.4";
      s.app.migrations = ["healStoragePathNames_2_4"];
      s.persistent.downloads.checkpoints = {
        old: {
          downloadId: "old",
          resource: url,
          dest: source,
          completedRanges: [{ start: 0, end: prefix.length - 1 }],
          etag: '"fixture"',
        },
      };
    });
    const saved = window.api;
    const manager = new DownloadManager({ concurrency: 1 });
    init(manager);
    const invoke = (key: string, ...args: any[]) =>
      Promise.resolve(transport.get(key)!({ sender: {} }, ...args));
    try {
      const original = h.getState().persistent.downloads.checkpoints.old;
      const publications: unknown[] = [];
      const unsubscribe = h.api.store.subscribe(() => {
        const state = h.getState();
        if (state.persistent.downloads.files.old.game[0] === "skyrimse")
          publications.push(state.persistent.downloads.checkpoints.old.dest);
      });
      await currentMigrate(h.api.store, "2.1.0-beta.4");
      unsubscribe();
      expect(publications.length).toBeGreaterThan(0);
      expect(publications.every((value) => value === moved)).toBe(true);
      const checkpoint = h.getState().persistent.downloads.checkpoints.old;
      expect(fs.existsSync(source)).toBe(occupied > 0);
      expect(fs.readFileSync(moved)).toEqual(prefix);
      expect(checkpoint).toEqual({ ...original, dest: moved });
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      window.api = {
        ...saved,
        downloader: {
          onResolve: vi.fn(),
          resume: (cp: any) => invoke("download:resume", cp),
          getStates: (ids: string[]) => invoke("download:getStates", ids),
        },
      } as any;
      new IPCDownloadAdapter(h.api);
      const resumed = await new Promise((r) => h.api.events.emit("resume-download", "old", r));
      expect(resumed).toBeNull();
      await manager.get("old")!.promise;
      expect(ranges).toContain(`bytes=${prefix.length}-${body.length - 1}`);
      expect(fs.readFileSync(moved)).toEqual(body);
      for (const [filename, bytes] of unrelated) expect(fs.readFileSync(filename)).toEqual(bytes);
      expect(h.getState().persistent.downloads.files.old.state).not.toBe("failed");
      const extracted = path.join(root, "extracted");
      await new Zip().extractFull(moved, extracted);
      expect(fs.readFileSync(path.join(extracted, "payload.txt"), "utf8")).toBe(
        "complete synthetic migration payload",
      );
    } finally {
      manager.get("old")?.cancel();
      await manager.get("old")?.waitForWrites();
      vi.clearAllTimers();
      vi.useRealTimers();
      window.api = saved;
      h.api.events.removeAllListeners();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const outcome of ["success", "missing", "denied", "publication-error"] as const) {
  test(`checkpoint publication preserves ownership and progress on ${outcome}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-migration-state-"));
    const directory = path.join(root, "downloads");
    const source = path.join(directory, "skyrimspecialedition", "archive.zip");
    const dest = path.join(directory, "skyrimse", "archive.zip");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    if (outcome !== "missing") fs.writeFileSync(source, "partial archive");
    const h = makeApiHarness(
      {
        downloads: {
          old: makeDownload({
            id: "old",
            game: ["skyrimspecialedition"],
            state: "paused",
            localPath: "archive.zip",
            received: 7,
          }),
          otherGame: makeDownload({
            id: "otherGame",
            game: ["fallout4"],
            state: "paused",
            localPath: "archive.zip",
            received: 7,
          }),
          unrelatedDest: makeDownload({
            id: "unrelatedDest",
            game: ["skyrimspecialedition"],
            state: "paused",
            localPath: "archive.zip",
            received: 7,
          }),
        },
      },
      [
        { path: ["persistent", "downloads"], reducer: downloadsReducer },
        { path: ["app"], reducer: appReducer },
      ],
    );
    const checkpoint = {
      downloadId: "old",
      resource: "http://127.0.0.1/unused",
      dest: source,
      completedRanges: [{ start: 0, end: 6 }],
      etag: '"retained"',
      resolvedResource: {
        probeEndpoint: { url: "http://127.0.0.1/unused", headers: { "X-Fixture": "retained" } },
      },
    };
    const otherCheckpoint = {
      ...checkpoint,
      downloadId: "otherGame",
      dest: path.join(directory, "fallout4", "archive.zip"),
    };
    const unrelatedCheckpoint = {
      ...checkpoint,
      downloadId: "unrelatedDest",
      dest: path.join(root, "unrelated.zip"),
    };
    h.setState((s) => {
      s.settings.downloads.path = directory;
      s.session.gameMode.known = [
        makeGameStored({ id: "skyrimse", details: { nexusPageId: "skyrimspecialedition" } }),
      ];
      s.app.appVersion = "2.1.0-beta.4";
      s.app.migrations = ["healStoragePathNames_2_4"];
      s.persistent.downloads.checkpoints = {
        old: checkpoint,
        otherGame: otherCheckpoint,
        unrelatedDest: unrelatedCheckpoint,
      };
    });
    const saved = window.api;
    const failed = outcome === "denied" || outcome === "publication-error";
    window.api = {
      ...saved,
      dialog: { ...saved.dialog, showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
    };
    if (outcome === "denied") fs.chmodSync(source, 0);
    const dispatch = h.api.store.dispatch;
    if (outcome === "publication-error")
      vi.spyOn(h.api.store, "dispatch").mockImplementation((action: any) => {
        if (Array.isArray(action.payload)) throw new Error("publication refused");
        return dispatch(action);
      });
    try {
      if (failed)
        await expect(currentMigrate(h.api.store, "2.1.0-beta.4")).rejects.toBeInstanceOf(Error);
      else await currentMigrate(h.api.store, "2.1.0-beta.4");
      const state = h.getState();
      expect(state.persistent.downloads.checkpoints.otherGame).toEqual(otherCheckpoint);
      expect(state.persistent.downloads.files.otherGame.game).toEqual(["fallout4"]);
      if (failed) {
        expect(state.persistent.downloads.checkpoints.old).toEqual(checkpoint);
        expect(state.persistent.downloads.checkpoints.unrelatedDest).toEqual(unrelatedCheckpoint);
        expect(state.persistent.downloads.files.old.game).toEqual(["skyrimspecialedition"]);
        expect(fs.existsSync(source)).toBe(true);
        expect(state.app.migrations).not.toContain("moveDomainFolders_2_1");
      } else if (outcome === "missing") {
        expect(state.persistent.downloads.checkpoints.old).toBeUndefined();
        expect(state.persistent.downloads.checkpoints.unrelatedDest).toBeUndefined();
        expect(state.persistent.downloads.files.old.received).toBe(0);
      } else {
        expect(state.persistent.downloads.checkpoints.old).toEqual({ ...checkpoint, dest });
        expect(state.persistent.downloads.checkpoints.unrelatedDest).toEqual(unrelatedCheckpoint);
        expect(state.persistent.downloads.files.old.received).toBe(7);
        expect(fs.readFileSync(dest, "utf8")).toBe("partial archive");
        expect(fs.existsSync(source)).toBe(false);
      }
    } finally {
      if (outcome === "denied") fs.chmodSync(source, 0o600);
      vi.restoreAllMocks();
      window.api = saved;
      h.api.events.removeAllListeners();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
