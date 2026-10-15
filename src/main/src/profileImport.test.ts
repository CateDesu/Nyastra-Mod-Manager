import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { finishProfileImport } from "./profileImport";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nyastra-import-state-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function database(seed: Record<string, unknown>) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  let snapshot: Map<string, string>;
  const persistor = {
    getAllKVs: () =>
      Promise.resolve([...values].map(([key, value]) => ({ key: key.split("###"), value }))),
    removeItem: (key: string[]) => {
      const prefix = key.join("###");
      for (const stored of values.keys())
        if (stored === prefix || stored.startsWith(prefix + "###")) values.delete(stored);
      return Promise.resolve();
    },
    setItem: vi.fn((key: string[], value: string | null) => {
      if (value !== null) values.set(key.join("###"), value);
      return Promise.resolve();
    }),
    beginTransaction: () => {
      snapshot = new Map(values);
      return Promise.resolve();
    },
    commitTransaction: vi.fn(() => Promise.resolve()),
    rollbackTransaction: vi.fn(() => {
      values.clear();
      for (const [key, value] of snapshot) values.set(key, value);
      return Promise.resolve();
    }),
  };
  return {
    values,
    persistor,
    read: (key: string) => {
      const value = values.get(key);
      return value === undefined ? undefined : (JSON.parse(value) as unknown);
    },
  };
}

describe("imported profile preparation", () => {
  it.each(["nyastra-import.json", "nyastra-import-complete.json"])(
    "rebases copied extension paths from %s while preserving profiles and mod paths",
    async (marker) => {
      await writeFile(
        path.join(root, marker),
        JSON.stringify({ version: 1, source: "/previous/Vortex" }),
      );
      await mkdir(path.join(root, "plugins", "game-re9"), { recursive: true });
      const db = database({
        "app###extensions###extension###path": "/previous/Vortex/plugins/game-re9",
        "app###extensions###extension###enabled": true,
        "app###extensions###disabled###path": "/previous/Vortex/plugins/game-re9",
        "app###extensions###disabled###enabled": false,
        "app###extensions###external###path": "/separate/plugins/custom-game",
        "app###extensions###missing###path": "/previous/Vortex/plugins/not-copied",
        "settings###gameMode###discovered###re9###extensionPath":
          "/previous/Vortex/plugins/game-re9",
        "settings###mods###installPath###re9": "/previous/Vortex/staging/re9",
        "persistent###profiles###p###modState###off###enabled": false,
        "persistent###mods###re9###mod###state": "installed",
        "confidential###account###nexus###APIKey": "current-login",
      });
      await finishProfileImport(db.persistor, root);
      expect(db.read("app###extensions###extension###path")).toBe(
        path.join(root, "plugins", "game-re9"),
      );
      expect(db.read("app###extensions###disabled###path")).toBe(
        path.join(root, "plugins", "game-re9"),
      );
      expect(db.read("app###extensions###disabled###enabled")).toBe(false);
      expect(db.read("app###extensions###external###path")).toBe("/separate/plugins/custom-game");
      expect(db.read("app###extensions###missing###path")).toBe(
        "/previous/Vortex/plugins/not-copied",
      );
      expect(db.read("settings###gameMode###discovered###re9###extensionPath")).toBe(
        path.join(root, "plugins", "game-re9"),
      );
      expect(db.read("settings###mods###installPath###re9")).toBe("/previous/Vortex/staging/re9");
      expect(db.read("persistent###profiles###p###modState###off###enabled")).toBe(false);
      expect(db.read("persistent###mods###re9###mod###state")).toBe("installed");
      if (marker === "nyastra-import-complete.json") {
        expect(db.read("confidential###account###nexus###APIKey")).toBe("current-login");
      }
      expect(
        JSON.parse(await readFile(path.join(root, "nyastra-import-complete.json"), "utf8")),
      ).toMatchObject({ version: 2 });
      db.persistor.setItem.mockClear();
      await finishProfileImport(db.persistor, root);
      expect(db.persistor.setItem).not.toHaveBeenCalled();
    },
  );

  it("rolls back an existing import repair without clearing its login or advancing the marker", async () => {
    const marker = path.join(root, "nyastra-import-complete.json");
    await writeFile(marker, JSON.stringify({ version: 1, source: "/previous/Vortex" }));
    await mkdir(path.join(root, "plugins", "game-re9"), { recursive: true });
    const db = database({
      "app###extensions###ext###path": "/previous/Vortex/plugins/game-re9",
      "confidential###account###nexus###APIKey": "current-login",
    });
    const before = new Map(db.values);
    db.persistor.setItem.mockRejectedValueOnce(new Error("disk failure"));
    await expect(finishProfileImport(db.persistor, root)).rejects.toThrow("disk failure");
    expect(db.values).toEqual(before);
    expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({ version: 1 });
  });

  it("preserves mod paths and instance ownership while clearing inherited credentials", async () => {
    await writeFile(
      path.join(root, "nyastra-import.json"),
      JSON.stringify({ version: 1, source: "/previous/Vortex" }),
    );
    const db = database({
      confidential: { account: { nexus: { OAuthCredentials: { token: "old-client-token" } } } },
      settings: {
        downloads: { path: "{USERDATA}/downloads", maxParallelDownloads: 3 },
        mods: { installPath: { re9: "{USERDATA}/{GAME}/mods", skyrimse: "/external/staging" } },
        analytics: { enabled: true },
        window: { maximized: true },
      },
      "persistent###nexus": { userInfo: { name: "previous login" }, newestVersion: "2.9.0" },
      "persistent###changelogs###changelogs": [{ version: "2.9.0", text: "Upstream release" }],
      "persistent###mods###re9###example###installationPath": "ExampleMod",
      "app###instanceId": "existing-staging-owner",
    });
    await finishProfileImport(db.persistor, root);
    expect(db.read("confidential")).toBeUndefined();
    expect(db.read("persistent###changelogs###changelogs")).toBeUndefined();
    expect(db.read("persistent###nexus###userInfo###name")).toBeUndefined();
    expect(db.read("persistent###nexus###newestVersion")).toBe("2.9.0");
    expect(db.read("settings###downloads###path")).toBe("/previous/Vortex/downloads");
    expect(db.read("settings###downloads###maxParallelDownloads")).toBe(3);
    expect(db.read("settings###mods###installPath###re9")).toBe("/previous/Vortex/{GAME}/mods");
    expect(db.read("settings###mods###installPath###skyrimse")).toBe("/external/staging");
    expect(db.read("settings###analytics###enabled")).toBe(false);
    expect(db.read("settings###window###maximized")).toBe(true);
    expect(db.read("persistent###mods###re9###example###installationPath")).toBe("ExampleMod");
    expect(db.read("app###instanceId")).toBe("existing-staging-owner");
    expect(
      JSON.parse(await readFile(path.join(root, "nyastra-import-complete.json"), "utf8")),
    ).toMatchObject({ source: "/previous/Vortex" });
    db.values.set("confidential###account###nexus###APIKey", JSON.stringify("new-login"));
    await finishProfileImport(db.persistor, root);
    expect(db.read("confidential###account###nexus###APIKey")).toBe("new-login");
  });
  it("preserves default staging paths for games without an explicit setting", async () => {
    await writeFile(
      path.join(root, "nyastra-import.json"),
      JSON.stringify({ version: 1, source: "/previous/Vortex" }),
    );
    const db = database({ "persistent###mods###re9###mod###state": "installed" });
    await finishProfileImport(db.persistor, root);
    expect(db.read("settings###mods###installPath###re9")).toBe("/previous/Vortex/{GAME}/mods");
    expect(db.read("settings###downloads###path")).toBe("/previous/Vortex/downloads");
  });
  it("rolls back failed state changes and retains the import marker for retry", async () => {
    await writeFile(
      path.join(root, "nyastra-import.json"),
      JSON.stringify({ version: 1, source: "/previous/Vortex" }),
    );
    const db = database({
      "confidential###account###nexus###APIKey": "old-token",
      "settings###downloads###path": "{USERDATA}/downloads",
    });
    const before = new Map(db.values);
    db.persistor.setItem.mockRejectedValueOnce(new Error("disk failure"));
    await expect(finishProfileImport(db.persistor, root)).rejects.toThrow("disk failure");
    expect(db.values).toEqual(before);
    expect(db.persistor.rollbackTransaction).toHaveBeenCalledOnce();
    expect(await readFile(path.join(root, "nyastra-import.json"), "utf8")).toContain("previous");
  });
});
