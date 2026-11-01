import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import Zip from "node-7z";
import { expect, test, vi } from "vitest";

import { IPCDownloadAdapter } from "../../../IPCDownloadAdapter";
import { downloadsReducer } from "../../../reducers/downloads";
import { makeApiHarness, makeDownload, makeProfile } from "../../../test-utils/builders";
import { UserCanceled } from "../../../util/CustomErrors";
import * as programFs from "../../../util/fs";
import { setTransferDownloads } from "../actions/transactions";
import { settingsReducer } from "../reducers/settings";
import { transactionsReducer } from "../reducers/transactions";
import { hasPendingArchiveAdmission } from "../util/archiveOwnership";
import { DOWNLOADS_DIR_TAG } from "../util/downloadDirectory";
import Settings from "./Settings";

vi.mock("../../../controls/ComponentEx", async (load) => ({
  ...(await load<object>()),
  connect: () => (value: unknown) => value,
  translate: () => (value: unknown) => value,
}));
const transport = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock("../../../../../main/src/ipc", () => ({
  betterIpcMain: { handle: (key: string, fn: (...args: any[]) => any) => transport.set(key, fn) },
}));
vi.mock("../../../../../main/src/logging", () => ({ log: vi.fn() }));

for (const mode of [
  "manual",
  "restart",
  "racing-resume",
  "racing-hydration",
  "racing-start",
] as const) {
  test(`moving Downloads preserves a native range resume: ${mode}`, async () => {
    const mainModules = path.resolve(__dirname, "../../../../../main/src/downloading");
    const { DownloadManager } = await import(/* @vite-ignore */ `${mainModules}/manager.ts`);
    const { init } = await import(/* @vite-ignore */ `${mainModules}/ipc.ts`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "folder-checkpoint-"));
    const source = path.join(root, "old");
    const destination = path.join(root, "new");
    const oldArchive = path.join(source, "game-a", "archive.zip");
    const newArchive = path.join(destination, "game-a", "archive.zip");
    const payload = path.join(root, "payload.txt");
    fs.writeFileSync(payload, "complete disposable archive payload");
    const complete = path.join(root, "complete.zip");
    await new Zip().add(complete, [payload]);
    const body = fs.readFileSync(complete);
    const prefix = body.subarray(0, Math.floor(body.length / 2));
    fs.mkdirSync(path.dirname(oldArchive), { recursive: true });
    fs.writeFileSync(oldArchive, prefix);
    fs.writeFileSync(path.join(source, DOWNLOADS_DIR_TAG), JSON.stringify({ instance: "proof" }));
    const requests: string[] = [];
    const ranges: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.method!);
      if (request.headers.range) ranges.push(request.headers.range);
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range ? Number(range[2]) : body.length - 1;
      response.writeHead(range ? 206 : 200, {
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
        etag: '"proof"',
        ...(range ? { "content-range": `bytes ${start}-${end}/${body.length}` } : {}),
      });
      response.end(request.method === "HEAD" ? undefined : body.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const h = makeApiHarness(
      {
        profiles: { p: makeProfile({ id: "p", gameId: "game-a" }) },
        activeProfileId: "p",
        downloads: {
          old: makeDownload({
            id: "old",
            game: ["game-a"],
            state: "paused",
            localPath: "archive.zip",
            received: prefix.length,
            size: body.length,
          }),
        },
      },
      [
        { path: ["persistent", "downloads"], reducer: downloadsReducer },
        { path: ["settings", "downloads"], reducer: settingsReducer },
        { path: ["persistent", "transactions"], reducer: transactionsReducer },
      ],
    );
    h.setState((state) => {
      state.app = { ...state.app, instanceId: "proof" };
      state.settings.downloads.path = source;
      state.persistent.downloads.checkpoints = {
        old: {
          downloadId: "old",
          resource: `http://127.0.0.1:${port}/archive.zip`,
          dest: oldArchive,
          completedRanges: [{ start: 0, end: prefix.length - 1 }],
          etag: '"proof"',
        },
      };
    });
    const savedApi = window.api;
    const manager = new DownloadManager({ concurrency: 1 });
    init(manager);
    const invoke = (key: string, ...args: any[]) =>
      Promise.resolve(transport.get(key)!({ sender: {} }, ...args));
    const ui: any = new (Settings as any)({
      downloadPath: source,
      modsInstallPath: path.join(root, "unused"),
      downloads: h.getState().persistent.downloads.files,
      instanceId: "proof",
      isPremium: true,
      parallelDownloads: 1,
      copyOnIFF: false,
      maxBandwidth: 0,
      collectionsInstallWhileDownloading: false,
      t: (value: string) => value,
      onSetTransfer: (value: string) => h.api.store.dispatch(setTransferDownloads(value)),
      onShowError: (...args: any[]) => {
        console.log("TRANSFER_ERROR", args);
        throw args[1];
      },
      onShowDialog: async () => ({ action: "Continue" }),
    });
    ui.setState = (value: object) => {
      ui.state = { ...ui.state, ...value };
    };
    ui.context = { api: h.api };
    try {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const resume = vi.fn((checkpoint: any) => invoke("download:resume", checkpoint));
      window.api = {
        ...savedApi,
        downloader: {
          onResolve: vi.fn(),
          configure: vi.fn().mockResolvedValue(undefined),
          resume,
          start: vi.fn(async (dest: string) => {
            fs.writeFileSync(dest, "new writer after move");
            return { downloadId: "new-writer" };
          }),
          getStates: (ids: string[]) => invoke("download:getStates", ids),
          cancel: (id: string) => invoke("download:cancel", id),
        },
      } as any;
      const adapter = new IPCDownloadAdapter(h.api);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const copying = new Promise<void>((r) => {
        entered = r;
      });
      const link = programFs.linkAsync;
      if (mode.startsWith("racing"))
        vi.spyOn(programFs, "linkAsync").mockImplementation((from, ...args) => {
          if (from !== oldArchive) return link(from, ...args);
          entered();
          return Bluebird.resolve(gate).then(() => link(from, ...args));
        });
      ui.setDownloadPath(destination);
      const moving = ui.onApply();
      let admitted: Promise<unknown> | undefined;
      try {
        if (mode.startsWith("racing")) {
          await copying;
          if (mode === "racing-start") {
            h.api.events.emit("start-download", ["http://127.0.0.1/unused"], { game: "game-a" });
          } else if (mode === "racing-hydration") {
            h.setState((s) => {
              s.persistent.downloads.files.old.state = "started";
            });
            admitted = adapter.hydrateFromState();
          } else
            admitted = new Promise((resolve) =>
              h.api.events.emit("resume-download", "old", resolve),
            );
          await new Promise<void>((r) => setImmediate(r));
          expect(resume).not.toHaveBeenCalled();
          expect(window.api.downloader.start).not.toHaveBeenCalled();
        }
      } finally {
        release();
      }
      await moving;
      expect(h.getState().settings.downloads.path).toBe(destination);
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.readFileSync(newArchive)).toEqual(prefix);
      expect(h.getState().persistent.downloads.checkpoints.old).toEqual({
        downloadId: "old",
        resource: `http://127.0.0.1:${port}/archive.zip`,
        dest: newArchive,
        completedRanges: [{ start: 0, end: prefix.length - 1 }],
        etag: '"proof"',
      });
      if (mode === "racing-start") {
        await vi.waitFor(() =>
          expect(h.getState().persistent.downloads.files["new-writer"]).toBeDefined(),
        );
        const writer = h.getState().persistent.downloads.files["new-writer"];
        const dest = path.join(destination, "game-a", writer.localPath);
        expect(window.api.downloader.start).toHaveBeenCalledWith(dest, expect.any(Number));
        expect(fs.readFileSync(dest, "utf8")).toBe("new writer after move");
        expect(fs.existsSync(source)).toBe(false);
      }
      if (admitted === undefined) {
        if (mode === "restart") {
          h.setState((s) => {
            s.persistent.downloads.files.old.state = "started";
          });
          admitted = adapter.hydrateFromState();
        } else
          admitted = new Promise((resolve) => h.api.events.emit("resume-download", "old", resolve));
      }
      await admitted;
      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume.mock.calls[0][0].dest).toBe(newArchive);
      await manager.get("old")!.promise;
      expect(manager.get("old")!.dest).toBe(newArchive);
      expect(fs.readFileSync(newArchive)).toEqual(body);
      expect(requests).toContain("GET");
      expect(ranges).toContain(`bytes=${prefix.length}-${body.length - 1}`);
      const extracted = path.join(root, "extracted");
      await new Zip().extractFull(newArchive, extracted);
      expect(fs.readFileSync(path.join(extracted, "payload.txt"), "utf8")).toBe(
        "complete disposable archive payload",
      );
    } finally {
      manager.get("old")?.cancel();
      await manager.get("old")?.waitForWrites();
      vi.clearAllTimers();
      vi.useRealTimers();
      window.api = savedApi;
      h.api.events.removeAllListeners();
      vi.restoreAllMocks();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const outcome of [
  "success",
  "wine-alias",
  "changed-input",
  "cleanup-canceled",
  "cleanup-denied",
  "collision",
  "canceled",
] as const) {
  test(`root publication keeps checkpoint ownership and ranges: ${outcome}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-root-state-"));
    const source =
      outcome === "wine-alias"
        ? path.join(root, ".wine", "drive_c", "Old")
        : path.join(root, "old");
    const alias = path.join(root, "old-alias");
    const pattern = path.join(root, "{USERNAME}", "new");
    const destination = path.join(root, os.userInfo().username, "new");
    const outside = path.join(root, "old-unrelated", "other.zip");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "unrelated prefix");
    fs.mkdirSync(source, { recursive: true });
    fs.symlinkSync(source, alias);
    fs.writeFileSync(
      path.join(source, DOWNLOADS_DIR_TAG),
      JSON.stringify({ instance: "state-test" }),
    );
    const h = makeApiHarness(
      { profiles: { p: makeProfile({ id: "p", gameId: "game-a" }) }, activeProfileId: "p" },
      [
        { path: ["persistent", "downloads"], reducer: downloadsReducer },
        { path: ["settings", "downloads"], reducer: settingsReducer },
        { path: ["persistent", "transactions"], reducer: transactionsReducer },
      ],
    );
    const checkpoints: Record<string, any> = {};
    const files: Record<string, any> = {};
    for (let i = 0; i < 300; i++) {
      const id = `paused-${i}`,
        game = i % 2 === 0 ? "game-a" : "game-b";
      const name = `${id}.zip`,
        dest = path.join(source, game, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, "prefix");
      files[id] = makeDownload({
        id,
        game: [game],
        state: "paused",
        localPath: name,
        received: 6,
        size: 50,
      });
      checkpoints[id] = {
        downloadId: id,
        resource: "http://127.0.0.1/unused",
        dest: path.join(i % 3 === 0 ? alias : source, game, name),
        completedRanges: [{ start: 0, end: 5 }],
        etag: '"retained"',
      };
    }
    const fileAlias = path.join(root, "file-alias.zip");
    fs.symlinkSync(path.join(source, "game-b", "paused-299.zip"), fileAlias);
    checkpoints["paused-299"].dest = fileAlias;
    if (outcome === "wine-alias")
      checkpoints["paused-2"].dest = path.join(source, "GAME-A", "PAUSED-2.ZIP");
    checkpoints.outside = { ...checkpoints["paused-0"], downloadId: "outside", dest: outside };
    h.setState((s) => {
      s.app = { ...s.app, instanceId: "state-test" };
      s.settings.downloads.path = source;
      s.persistent.downloads.files = files;
      s.persistent.downloads.checkpoints = checkpoints;
    });
    if (outcome === "collision") {
      fs.mkdirSync(path.join(destination, "game-a"), { recursive: true });
      fs.writeFileSync(
        path.join(destination, DOWNLOADS_DIR_TAG),
        JSON.stringify({ instance: "state-test" }),
      );
      fs.writeFileSync(
        path.join(destination, "game-a", "paused-0.zip"),
        "previous destination bytes",
      );
    }
    const remove = programFs.removeAsync;
    if (outcome.startsWith("cleanup"))
      vi.spyOn(programFs, "removeAsync").mockImplementation((target, ...args) => {
        if (target === source) {
          if (outcome === "cleanup-canceled") return Bluebird.reject(new UserCanceled());
          fs.chmodSync(source, 0);
        }
        return remove(target, ...args);
      });
    if (outcome === "canceled")
      vi.spyOn(programFs, "linkAsync").mockRejectedValue(new UserCanceled());
    const observations: string[] = [];
    const stop = h.api.store.subscribe(() => {
      const state = h.getState();
      const moved = state.settings.downloads.path === pattern;
      for (let i = 0; i < 300; i++) {
        const id = `paused-${i}`,
          checkpoint = state.persistent.downloads.checkpoints[id];
        const expected = moved
          ? path.join(destination, ...files[id].game, files[id].localPath)
          : checkpoints[id].dest;
        if (checkpoint.dest !== expected) observations.push(id);
      }
    });
    const errors = vi.fn();
    const ui: any = new (Settings as any)({
      downloadPath: source,
      modsInstallPath: path.join(root, "unused"),
      downloads: files,
      instanceId: "state-test",
      isPremium: true,
      parallelDownloads: 1,
      copyOnIFF: false,
      maxBandwidth: 0,
      collectionsInstallWhileDownloading: false,
      t: (value: string) => value,
      onSetTransfer: (value: string) => h.api.store.dispatch(setTransferDownloads(value)),
      onShowError: errors,
      onShowDialog: async () => ({ action: "Continue" }),
    });
    ui.setState = (value: object) => {
      ui.state = { ...ui.state, ...value };
    };
    ui.context = { api: h.api };
    try {
      if (outcome === "changed-input")
        h.api.events.once("will-move-downloads", () =>
          ui.setDownloadPath(path.join(root, "later-choice")),
        );
      ui.setDownloadPath(pattern);
      await ui.onApply();
      expect(observations).toEqual([]);
      const moved = !["collision", "canceled"].includes(outcome);
      expect(h.getState().settings.downloads.path).toBe(moved ? pattern : source);
      expect(h.getState().persistent.downloads.checkpoints.outside).toEqual(checkpoints.outside);
      for (let i = 0; i < 300; i++) {
        const id = `paused-${i}`;
        expect(h.getState().persistent.downloads.checkpoints[id]).toEqual({
          ...checkpoints[id],
          dest: moved
            ? path.join(destination, ...files[id].game, files[id].localPath)
            : checkpoints[id].dest,
        });
      }
      if (moved) {
        for (const id of ["paused-2", "paused-299"])
          expect(
            fs.readFileSync(h.getState().persistent.downloads.checkpoints[id].dest, "utf8"),
          ).toBe("prefix");
      }
      expect(fs.readFileSync(outside, "utf8")).toBe("unrelated prefix");
      if (outcome === "collision")
        expect(fs.readFileSync(path.join(destination, "game-a", "paused-0.zip"), "utf8")).toBe(
          "previous destination bytes",
        );
      expect(errors).toHaveBeenCalledTimes(outcome === "collision" ? 1 : 0);
    } finally {
      stop();
      if (fs.existsSync(source)) fs.chmodSync(source, 0o700);
      h.api.events.removeAllListeners();
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const admission of [
  "manual",
  "startup",
  "network",
  "network-error",
  "network-cancel",
] as const) {
  test(`a ${admission} resume admitted first prevents relocation of its writer`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-admitted-resume-"));
    const source = path.join(root, "old"),
      destination = path.join(root, "new");
    const archive = path.join(source, "game-a", "archive.zip");
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, "prefix");
    fs.writeFileSync(
      path.join(source, DOWNLOADS_DIR_TAG),
      JSON.stringify({ instance: "admitted" }),
    );
    const h = makeApiHarness(
      {
        profiles: { p: makeProfile({ id: "p", gameId: "game-a" }) },
        activeProfileId: "p",
        downloads: {
          paused: makeDownload({
            id: "paused",
            game: ["game-a"],
            state: "paused",
            localPath: "archive.zip",
            received: 6,
            size: 50,
          }),
        },
      },
      [
        { path: ["persistent", "downloads"], reducer: downloadsReducer },
        { path: ["settings", "downloads"], reducer: settingsReducer },
        { path: ["persistent", "transactions"], reducer: transactionsReducer },
      ],
    );
    const checkpoint = {
      downloadId: "paused",
      resource: "http://127.0.0.1/unused",
      dest: archive,
      completedRanges: [{ start: 0, end: 5 }],
      etag: '"retained"',
    };
    h.setState((s) => {
      s.app = { ...s.app, instanceId: "admitted" };
      s.settings.downloads.path = source;
      s.persistent.downloads.checkpoints = { paused: checkpoint };
    });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reserved = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const savedApi = window.api;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    window.api = {
      ...savedApi,
      downloader: {
        onResolve: vi.fn(),
        configure: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn(() => {
          entered();
          return gate;
        }),
        start: vi.fn(async (dest: string) => {
          entered();
          await gate;
          if (admission !== "network") throw new UserCanceled();
          fs.writeFileSync(dest, "admitted writer");
          return { downloadId: "network" };
        }),
        getStates: vi.fn().mockResolvedValue({}),
      },
    } as any;
    if (admission === "network-error")
      vi.mocked(window.api.downloader.start).mockImplementation(async () => {
        entered();
        await gate;
        throw new Error("native admission failed");
      });
    const adapter = new IPCDownloadAdapter(h.api);
    const errors = vi.fn();
    const ui: any = new (Settings as any)({
      downloadPath: source,
      modsInstallPath: path.join(root, "unused"),
      downloads: h.getState().persistent.downloads.files,
      instanceId: "admitted",
      isPremium: true,
      parallelDownloads: 1,
      copyOnIFF: false,
      maxBandwidth: 0,
      collectionsInstallWhileDownloading: false,
      t: (value: string) => value,
      onSetTransfer: (value: string) => h.api.store.dispatch(setTransferDownloads(value)),
      onShowError: errors,
      onShowDialog: async () => ({ action: "Continue" }),
    });
    ui.setState = (value: object) => {
      ui.state = { ...ui.state, ...value };
    };
    ui.context = { api: h.api };
    let resuming: Promise<unknown>;
    try {
      if (admission.startsWith("network")) {
        resuming = Promise.resolve();
        h.api.events.emit("start-download", ["http://127.0.0.1/unused"], { game: "game-a" });
      } else if (admission === "startup") {
        h.setState((s) => {
          s.persistent.downloads.files.paused.state = "started";
        });
        resuming = adapter.hydrateFromState();
      } else
        resuming = new Promise((resolve) =>
          h.api.events.emit("resume-download", "paused", resolve),
        );
      await reserved;
      ui.setDownloadPath(destination);
      await ui.onApply();
      expect(h.getState().settings.downloads.path).toBe(source);
      expect(h.getState().persistent.downloads.checkpoints.paused).toEqual(checkpoint);
      expect(fs.readFileSync(archive, "utf8")).toBe("prefix");
      expect(fs.existsSync(destination)).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(ui.state.busy).toBeUndefined();
      release();
      if (admission.startsWith("network")) {
        await vi.waitFor(() => expect(hasPendingArchiveAdmission(h.api)).toBe(false));
        if (admission === "network") {
          const writer = h.getState().persistent.downloads.files.network;
          expect(fs.readFileSync(path.join(source, "game-a", writer.localPath), "utf8")).toBe(
            "admitted writer",
          );
        } else {
          await ui.onApply();
          expect(errors).toHaveBeenCalledTimes(1);
          expect(h.getState().settings.downloads.path).toBe(destination);
          expect(h.getState().persistent.downloads.checkpoints.paused.dest).toBe(
            path.join(destination, "game-a", "archive.zip"),
          );
        }
      }
    } finally {
      release();
      await resuming!;
      vi.clearAllTimers();
      vi.useRealTimers();
      window.api = savedApi;
      h.api.events.removeAllListeners();
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
