import * as nodeFs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { runInThisContext } from "node:vm";

import Bluebird from "bluebird";
import * as React from "react";
import ts from "typescript";
import { expect, vi } from "vitest";

import { makeMod, makeProfile } from "../../../test-utils/builders";
import type { IDeploymentHarness } from "../../../test-utils/deploymentTest";
import { test } from "../../../test-utils/deploymentTest";
import type { IExtensionContext } from "../../../types/IExtensionContext";
import Debouncer from "../../../util/Debouncer";
import * as fs from "../../../util/fs";
import makeReactive from "../../../util/makeReactive";
import * as selectors from "../../../util/selectors";
import { getSafe } from "../../../util/storeHelper";
import { batchDispatch, makeQueue } from "../../../util/util";
import * as actions from "../actions/mods";
import { dealWithExternalChanges } from "./externalChanges";

function Presentation() {}

async function bounded<T>(work: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Notification work did not drain")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function notificationConsumers(h: IDeploymentHarness, overrides = false) {
  const queues: Array<ReturnType<typeof makeQueue>> = [];
  const debouncers: Debouncer[] = [];
  class ObservedDebouncer extends Debouncer {
    constructor(...args: ConstructorParameters<typeof Debouncer>) {
      super(...args);
      debouncers.push(this);
    }
  }
  const bridge = {
    actions,
    fs,
    selectors,
    PureComponentEx: React.PureComponent,
    OptionsFilter: Presentation,
    util: {
      getSafe,
      batchDispatch,
      makeReactive,
      Debouncer: ObservedDebouncer,
      makeQueue: () => {
        const queue = makeQueue();
        queues.push(queue);
        return queue;
      },
      installIconSet: () => Bluebird.resolve(),
    },
  };

  // Load the shipped entry points with their real selectors and file classification.
  // Only extension registration, API exports and unused presentation imports are adapted.
  const load = (filename: string) => {
    const nativeRequire = createRequire(filename);
    const require = (id: string) => {
      if (id === "@nexusmods/vortex-api") return bridge;
      if (id === "./filetypes" || id === "./selectors") {
        return load(path.join(path.dirname(filename), id + ".ts"));
      }
      if (id.startsWith("./")) return { __esModule: true, default: Presentation };
      return nativeRequire(id);
    };
    const compiled = ts.transpileModule(nodeFs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    const module: { exports: { default?: (context: Partial<IExtensionContext>) => void } } = {
      exports: {},
    };
    runInThisContext(`(function(require, module, exports, __dirname) {${compiled}\n})`, {
      filename,
    })(require, module, module.exports, path.dirname(filename));
    return module.exports;
  };

  const startup: Array<() => unknown> = [];
  const context: Partial<IExtensionContext> = new Proxy(
    {
      api: h.api,
      once: (callback: () => unknown) => startup.push(callback),
    },
    { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) },
  );
  h.api.setStylesheet = vi.fn<typeof h.api.setStylesheet>();
  load(path.resolve("../../extensions/mod-content/src/index.tsx")).default(context);
  if (overrides) {
    load(path.resolve("../../extensions/mod-dependency-manager/src/index.tsx")).default(context);
  }

  return {
    start: async () => {
      await Promise.all(startup.map((callback) => callback()));
    },
    holdReads: () => {
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = queues[0](() => gate, false);
      return { release, held };
    },
    drain: async () => {
      await Promise.all(queues.map((queue) => bounded(queue(() => Bluebird.resolve(), false))));
      await bounded(
        Promise.all(
          debouncers.map((debouncer) =>
            Bluebird.fromCallback<void>((callback) => debouncer.wait(callback)),
          ),
        ),
      );
    },
    close: () => {
      debouncers.forEach((debouncer) => debouncer.clear());
      h.api.events.removeAllListeners();
    },
  };
}

function gameState(recordId: string, activeProfileId: string) {
  return {
    profiles: {
      selected: makeProfile({ id: "selected", gameId: "skyrimse" }),
      other: makeProfile({ id: "other", gameId: "another-game" }),
    },
    activeProfileId,
    mods: {
      skyrimse: {
        [recordId]: makeMod({
          id: recordId,
          installationPath: "SomeMod",
          attributes: { content: ["selected initial"], noContent: true },
        }),
      },
      "another-game": {
        [recordId]: makeMod({
          id: recordId,
          installationPath: "OtherStagingName",
          attributes: { content: ["other original"], noContent: false },
        }),
      },
    },
  };
}

function setStagingPaths(h: IDeploymentHarness) {
  const otherStaging = h.inGame("other-staging");
  nodeFs.mkdirSync(path.join(otherStaging, "SomeMod"), { recursive: true });
  nodeFs.writeFileSync(path.join(otherStaging, "SomeMod", "wrong.ini"), "other game");
  h.setState((state) => {
    state.settings.mods.installPath.skyrimse = h.stagingDir;
    state.settings.mods.installPath["another-game"] = otherStaging;
  });
}

for (const scenario of [
  "matching active",
  "different staging name",
  "other active game",
  "switch while queued",
] as const) {
  test(`external content notifications persist the selected record with ${scenario}`, async ({
    makeDeployment,
  }) => {
    const recordId = scenario === "different staging name" ? "record-id" : "SomeMod";
    const h = makeDeployment({
      files: { "config.ini": "removed", "textures/detail.dds": "retained texture" },
      ...gameState(recordId, scenario === "other active game" ? "other" : "selected"),
    });
    setStagingPaths(h);
    const consumer = notificationConsumers(h);
    let held: ReturnType<typeof consumer.holdReads>;
    const writes: string[] = [];
    const stop = h.api.store.subscribe(() => {
      if (
        h.getState().persistent.mods["another-game"][recordId].attributes.content[0] !==
        "other original"
      ) {
        writes.push("other game changed");
      }
    });
    try {
      await consumer.start();
      const manifest = await h.deploy();
      nodeFs.unlinkSync(path.join(h.stagingDir, "SomeMod", "config.ini"));
      if (scenario === "switch while queued") held = consumer.holdReads();
      await dealWithExternalChanges(
        h.api,
        h.method,
        "selected",
        h.stagingDir,
        { "": h.gameDir },
        { "": manifest },
        new Set(["SomeMod"]),
      );
      if (held) {
        h.setState((state) => {
          state.settings.profiles.activeProfileId = "other";
        });
        held.release();
        await bounded(held.held);
      }
      await consumer.drain();
      const selected = h.getState().persistent.mods.skyrimse[recordId].attributes;
      expect.soft(selected.content).toEqual(["texture"]);
      expect.soft(selected.noContent).toBe(false);
      expect
        .soft(h.getState().persistent.mods["another-game"][recordId].attributes)
        .toEqual({ content: ["other original"], noContent: false });
      expect(writes).toEqual([]);
    } finally {
      held?.release();
      try {
        await consumer.drain();
      } finally {
        stop();
        consumer.close();
      }
    }
  });
}

test("external content notifications persist an empty selected mod without changing another game", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    files: { "config.ini": "removed" },
    ...gameState("record-id", "other"),
  });
  setStagingPaths(h);
  h.setState((state) => {
    state.persistent.mods.skyrimse["record-id"].attributes.noContent = false;
  });
  const consumer = notificationConsumers(h);
  try {
    await consumer.start();
    const manifest = await h.deploy();
    nodeFs.unlinkSync(path.join(h.stagingDir, "SomeMod", "config.ini"));
    await dealWithExternalChanges(
      h.api,
      h.method,
      "selected",
      h.stagingDir,
      { "": h.gameDir },
      { "": manifest },
      new Set(["SomeMod"]),
    );
    await consumer.drain();
    expect(h.getState().persistent.mods.skyrimse["record-id"].attributes).toEqual({
      content: [],
      noContent: true,
    });
    expect(h.getState().persistent.mods["another-game"]["record-id"].attributes).toEqual({
      content: ["other original"],
      noContent: false,
    });
  } finally {
    try {
      await consumer.drain();
    } finally {
      consumer.close();
    }
  }
});

for (const activeProfileId of ["selected", "other"]) {
  test(`override notifications honor their explicit game with ${activeProfileId} active`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ files: {}, ...gameState("record-id", activeProfileId) });
    const removed = h.inGame("config.ini");
    const retained = h.inGame("keep.ini");
    h.setState((state) => {
      state.persistent.mods.skyrimse["record-id"].fileOverrides = [removed, retained];
      state.persistent.mods["another-game"]["record-id"].fileOverrides = [retained];
    });
    const consumer = notificationConsumers(h, true);
    try {
      await consumer.start();
      h.api.events.emit("check-file-override-redundancies", "skyrimse", { "record-id": [removed] });
      await consumer.drain();
      expect
        .soft(h.getState().persistent.mods.skyrimse["record-id"].fileOverrides)
        .toEqual([retained]);
      expect(h.getState().persistent.mods["another-game"]["record-id"].fileOverrides).toEqual([
        retained,
      ]);
    } finally {
      try {
        await consumer.drain();
      } finally {
        consumer.close();
      }
    }
  });
}

for (const scenario of [
  "matching active",
  "different staging name",
  "other active game",
  "manifest target",
] as const) {
  test(`external changes clear only the removed file's override through both actual listeners with ${scenario}`, async ({
    makeDeployment,
  }) => {
    const recordId = ["matching active", "manifest target"].includes(scenario)
      ? "SomeMod"
      : "record-id";
    const h = makeDeployment({
      files: { "config.ini": "removed", "textures/detail.dds": "retained texture" },
      ...gameState(recordId, scenario === "other active game" ? "other" : "selected"),
    });
    setStagingPaths(h);
    const target = scenario === "manifest target" ? "Nested" : "";
    const removed = h.inGame(path.join(target, "config.ini"));
    const retained = h.inGame("keep.ini");
    const consumer = notificationConsumers(h, true);
    try {
      await consumer.start();
      await h.method.prepare(h.gameDir, false, [], h.normalize);
      await h.method.activate(path.join(h.stagingDir, "SomeMod"), "SomeMod", target, new Set());
      const manifest = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
      h.setState((state) => {
        state.persistent.mods.skyrimse[recordId].fileOverrides = [removed, retained];
        state.persistent.mods["another-game"][recordId].fileOverrides = [retained];
      });
      nodeFs.unlinkSync(path.join(h.stagingDir, "SomeMod", "config.ini"));
      await dealWithExternalChanges(
        h.api,
        h.method,
        "selected",
        h.stagingDir,
        { "": h.gameDir },
        { "": manifest },
        new Set(["SomeMod"]),
      );
      await consumer.drain();
      const selected = h.getState().persistent.mods.skyrimse[recordId];
      expect.soft(selected.fileOverrides).toEqual([retained]);
      expect.soft(selected.attributes).toEqual({ content: ["texture"], noContent: false });
      const other = h.getState().persistent.mods["another-game"][recordId];
      expect.soft(other.fileOverrides).toEqual([retained]);
      expect(other.attributes).toEqual({ content: ["other original"], noContent: false });
    } finally {
      try {
        await consumer.drain();
      } finally {
        consumer.close();
      }
    }
  });
}

test("an unknown staging source cannot notify an unrelated record with the same name", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    files: { "config.ini": "removed" },
    ...gameState("SomeMod", "selected"),
  });
  setStagingPaths(h);
  nodeFs.mkdirSync(path.join(h.stagingDir, "UnrelatedStaging"));
  nodeFs.writeFileSync(
    path.join(h.stagingDir, "UnrelatedStaging", "unrelated.esp"),
    "unrelated plugin",
  );
  h.setState((state) => {
    state.persistent.mods.skyrimse.SomeMod.installationPath = "UnrelatedStaging";
  });
  const consumer = notificationConsumers(h, true);
  const emit = vi.spyOn(h.api.events, "emit");
  try {
    await consumer.start();
    const manifest = await h.deploy();
    nodeFs.unlinkSync(path.join(h.stagingDir, "SomeMod", "config.ini"));
    await dealWithExternalChanges(
      h.api,
      h.method,
      "selected",
      h.stagingDir,
      { "": h.gameDir },
      { "": manifest },
      new Set(["SomeMod"]),
    );
    await consumer.drain();
    expect(h.getState().persistent.mods.skyrimse.SomeMod.attributes).toEqual({
      content: ["selected initial"],
      noContent: true,
    });
    expect(emit).not.toHaveBeenCalledWith(
      "mod-content-changed",
      expect.anything(),
      expect.anything(),
    );
    expect(emit).not.toHaveBeenCalledWith(
      "check-file-override-redundancies",
      expect.anything(),
      expect.anything(),
    );
  } finally {
    try {
      await consumer.drain();
    } finally {
      consumer.close();
    }
  }
});
