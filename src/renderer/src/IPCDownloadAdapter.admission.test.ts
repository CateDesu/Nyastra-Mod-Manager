import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";

import {
  hasPendingArchiveAdmission,
  withArchiveMutation,
} from "./extensions/download_management/util/archiveOwnership";
import { NxmProtocol } from "./extensions/nexus_integration/nxmProtocol";
import { IPCDownloadAdapter } from "./IPCDownloadAdapter";
import { makeDownloadAdapterHarness } from "./test-utils/builders";
import type { IState } from "./types/IState";

vi.mock("./extensions/nexus_integration/util", async (load) => ({
  ...(await load<object>()),
  getInfoGraphQL: vi.fn(async () => ({
    modInfo: { direct_download_enabled: false },
    fileInfo: {},
  })),
}));

const freeQueue = (state: IState) =>
  (state.session as IState["session"] & { nexus: { freeUserDLQueue: string[] } }).nexus
    .freeUserDLQueue;

const urls = [
  "nxm://skyrimspecialedition/mods/100/files/500",
  "nxm://skyrimspecialedition/mods/200/files/600",
];
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

for (const removePaused of [false, true]) {
  test(`one Cancel completes both requested free downloads, unrelated removal=${removePaused}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nyastra-admission-"));
    const saved = window.api;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const h = makeDownloadAdapterHarness(IPCDownloadAdapter, { downloadDirectory: root });
    const nxm = new NxmProtocol(h.api, () => undefined as never);
    h.adapter.registerProtocol("nxm", nxm.resolve);
    const callbacks = [vi.fn(), vi.fn()];
    try {
      await mkdir(path.dirname(h.dest), { recursive: true });
      await writeFile(h.dest, "unrelated paused archive");
      for (let i = 0; i < urls.length; i++)
        h.events.emit("start-download", [urls[i]], { game: "skyrimse" }, undefined, callbacks[i]);
      await vi.waitFor(() => expect([...freeQueue(h.getState())].sort()).toEqual([...urls].sort()));
      expect(hasPendingArchiveAdmission(h.api)).toBe(true);
      if (removePaused) {
        const callback = vi.fn();
        h.events.emit("remove-download", h.downloadId, callback);
        await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(null));
        await expect(access(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
        expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
        expect([...freeQueue(h.getState())].sort()).toEqual([...urls].sort());
      }
      expect(nxm.dialogHandlers.onCancel(urls[0])).toBe(true);
      await vi.waitFor(() => {
        for (const callback of callbacks)
          expect(callback).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ name: "UserCanceled" }),
          );
        expect(freeQueue(h.getState())).toEqual([]);
        expect(hasPendingArchiveAdmission(h.api)).toBe(false);
      });
      await flush();
      expect(h.start).toHaveBeenCalledTimes(2);
      expect(freeQueue(h.getState())).toEqual([]);
      await withArchiveMutation(h.api, async () => {});
    } finally {
      nxm.dialogHandlers.onCancel(urls[0]);
      await flush();
      h.events.removeAllListeners();
      vi.clearAllTimers();
      vi.useRealTimers();
      window.api = saved;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const outcome of ["success", "error", "existing", "dialog-error"] as const) {
  test(`releases admission after ${outcome}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nyastra-admission-release-"));
    const saved = window.api;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const h = makeDownloadAdapterHarness(IPCDownloadAdapter, { downloadDirectory: root });
    const callback = vi.fn();
    try {
      if (outcome === "error") h.start.mockRejectedValueOnce(new Error("native start refused"));
      if (outcome === "existing" || outcome === "dialog-error") {
        await mkdir(path.dirname(h.dest), { recursive: true });
        await writeFile(h.dest, "existing archive");
        if (outcome === "dialog-error")
          h.api.showDialog = vi.fn().mockRejectedValue(new Error("dialog refused"));
      }
      h.events.emit(
        "start-download",
        ["http://127.0.0.1/unused"],
        { game: "skyrimse" },
        "file.bin",
        callback,
        outcome === "dialog-error" ? "ask" : "never",
      );
      await vi.waitFor(() => {
        expect(hasPendingArchiveAdmission(h.api)).toBe(false);
        if (outcome === "success")
          expect(h.getState().persistent.downloads.files["new-0"]).toBeDefined();
        else expect(callback).toHaveBeenCalledTimes(1);
      });
      if (outcome === "success") expect(callback).not.toHaveBeenCalled();
      else expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
      if (outcome === "existing" || outcome === "dialog-error")
        expect(h.start).not.toHaveBeenCalled();
    } finally {
      h.events.removeAllListeners();
      vi.clearAllTimers();
      vi.useRealTimers();
      window.api = saved;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a settled start cannot release another start's root reservation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nyastra-admission-owners-"));
  const saved = window.api;
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const h = makeDownloadAdapterHarness(IPCDownloadAdapter, { downloadDirectory: root });
  let accept!: (result: { urls: string[]; meta: unknown }) => void;
  let refuse!: (error: Error) => void;
  const first = new Promise<{ urls: string[]; meta: unknown }>((resolve) => {
    accept = resolve;
  });
  const second = new Promise<{ urls: string[]; meta: unknown }>((_resolve, reject) => {
    refuse = reject;
  });
  const secondCallback = vi.fn();
  h.adapter.registerProtocol("fixture", (input) => (input.includes("first") ? first : second));
  try {
    h.events.emit("start-download", ["fixture://first/file"], { game: "skyrimse" });
    h.events.emit(
      "start-download",
      ["fixture://second/file"],
      { game: "skyrimse" },
      undefined,
      secondCallback,
    );
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
    accept({ urls: ["http://127.0.0.1/unused"], meta: {} });
    await vi.waitFor(() =>
      expect(
        Object.values(h.getState().persistent.downloads.files).some(
          (row) => row.urls?.[0] === "fixture://first/file",
        ),
      ).toBe(true),
    );
    expect(hasPendingArchiveAdmission(h.api)).toBe(true);
    refuse(new Error("second protocol refused"));
    await vi.waitFor(() => {
      expect(secondCallback).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "second protocol refused" }),
      );
      expect(hasPendingArchiveAdmission(h.api)).toBe(false);
    });
    expect(
      Object.values(h.getState().persistent.downloads.files).some(
        (row) => row.urls?.[0] === "fixture://second/file",
      ),
    ).toBe(false);
  } finally {
    accept({ urls: ["http://127.0.0.1/unused"], meta: {} });
    refuse(new Error("fixture cleanup"));
    await flush();
    h.events.removeAllListeners();
    vi.clearAllTimers();
    vi.useRealTimers();
    window.api = saved;
    await rm(root, { recursive: true, force: true });
  }
});
