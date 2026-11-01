import * as fs from "node:fs";
import path from "node:path";

import Bluebird from "bluebird";
import { afterEach, expect, vi, test } from "vitest";

import {
  makeMod,
  makeProfile,
  makeApiHarness,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import type { IDeploymentOptions } from "../../test-utils/deploymentTest";
import { makeDeploymentHarness } from "../../test-utils/deploymentTest";
import { getGame } from "../gamemode_management/util/getGame";
import { setDeploymentNecessary } from "./actions/deployment";
import {
  addModRule,
  cacheModReference,
  removeModRule,
  setModAttribute,
  setFileOverride,
} from "./actions/mods";
import { onModsChanged } from "./eventHandlers";
import deployMods from "./modActivation";
import { deploymentReducer } from "./reducers/deployment";
import type { IDeployedFile } from "./types/IDeploymentMethod";
import type { IModRule } from "./types/IMod";
import { saveActivation, withActivationLock } from "./util/activationStore";
import BlacklistSet from "./util/BlacklistSet";
import { findModByRef } from "./util/findModByRef";
import sortMods from "./util/sort";
import { setResolvedCB } from "./util/testModReference";

afterEach(() => {
  vi.restoreAllMocks();
  resetHarnessRegistries();
});

for (const scenario of [
  "add-after",
  "reverse-order",
  "remove-after",
  "dependency-only",
  "attribute-only",
  "file-override",
] as const) {
  test(`rule dirty detection and native conflict winner: ${scenario}`, async () => {
    await import("./index.js");
    expect(global.Promise).toBe(Bluebird);
    expect(Reflect.get(global.Promise, "withResolvers")).toBeUndefined();
    const oldRule: IModRule = {
      type: scenario === "reverse-order" ? "before" : "after",
      reference: { id: "B" },
    };
    const hasRule = ["reverse-order", "remove-after"].includes(scenario);
    const options: IDeploymentOptions = {
      files: { "config.ini": "from A" },
      modName: "A",
      activeProfileId: "p",
      profiles: {
        p: makeProfile({
          id: "p",
          gameId: "skyrimse",
          modState: { A: { enabled: true, enabledTime: 0 }, B: { enabled: true, enabledTime: 0 } },
        }),
      },
      mods: {
        skyrimse: {
          A: makeMod({ id: "A", installationPath: "A", rules: hasRule ? [oldRule] : [] }),
          B: makeMod({ id: "B", installationPath: "B", rules: [] }),
        },
      },
    };
    const nativeH = makeDeploymentHarness(options);
    try {
      const h = {
        ...nativeH,
        ...makeApiHarness(options, [
          { path: ["persistent", "deployment"], reducer: deploymentReducer },
        ]),
      };
      fs.mkdirSync(path.join(h.stagingDir, "B"));
      fs.writeFileSync(path.join(h.stagingDir, "B", "config.ini"), "from B");
      h.setState((state) => {
        state.app = { ...state.app, instanceId: "rules-audit" };
        state.persistent.deployment.needToDeploy.skyrimse = false;
        state.settings.automation = { ...state.settings.automation, deploy: true };
      });
      h.api.lookupModMeta = vi.fn<typeof h.api.lookupModMeta>().mockResolvedValue([]);
      let manifest: IDeployedFile[] = [];
      let actualDeploys = 0;
      const work: PromiseLike<unknown>[] = [];
      const perform = async () => {
        const ordered = await sortMods(
          "skyrimse",
          Object.values(h.getState().persistent.mods.skyrimse),
          h.api,
        );
        manifest = await deployMods(
          h.api,
          "skyrimse",
          h.stagingDir,
          h.gameDir,
          ordered,
          h.method,
          manifest,
          "",
          new BlacklistSet([], getGame("skyrimse"), h.normalize),
          () => "",
        );
        await saveActivation(
          "skyrimse",
          "",
          "rules-audit",
          h.gameDir,
          h.stagingDir,
          manifest,
          h.method.id,
        );
        actualDeploys++;
        h.api.store.dispatch(setDeploymentNecessary("skyrimse", false));
      };
      await perform();
      const before = fs.readFileSync(h.inGame("config.ini"), "utf8");
      let dirtyObserved = false;
      let handlerCalls = 0;
      h.api.onStateChange(["persistent", "mods"], (previous, current) => {
        handlerCalls++;
        onModsChanged(h.api, previous, current);
      });
      h.api.onStateChange(["persistent", "deployment", "needToDeploy"], (_previous, current) => {
        if (current.skyrimse) {
          dirtyObserved = true;
          const p = withActivationLock(perform);
          work.push(p);
          p.catch(() => undefined);
        }
      });
      if (scenario === "add-after" || scenario === "reverse-order")
        h.api.store.dispatch(
          addModRule("skyrimse", "A", { type: "after", reference: { id: "B" } }),
        );
      if (scenario === "remove-after")
        h.api.store.dispatch(removeModRule("skyrimse", "A", oldRule));
      if (scenario === "dependency-only")
        h.api.store.dispatch(
          addModRule("skyrimse", "A", { type: "requires", reference: { id: "B" } }),
        );
      if (scenario === "attribute-only")
        h.api.store.dispatch(
          setModAttribute("skyrimse", "A", "description", "changed description"),
        );
      if (scenario === "file-override")
        h.api.store.dispatch(setFileOverride("skyrimse", "A", [h.inGame("config.ini")]));
      const settledErrors: unknown[] = [];
      let observed = -1;
      while (observed !== work.length) {
        observed = work.length;
        await Promise.all(
          work.map((p) =>
            Promise.resolve(p).then(
              () => undefined,
              (e) => {
                settledErrors.push(e);
              },
            ),
          ),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await withActivationLock(() => Promise.resolve());
      const expectedDirty = [
        "add-after",
        "reverse-order",
        "remove-after",
        "file-override",
      ].includes(scenario);
      const expectedWinner =
        scenario === "remove-after"
          ? "from B"
          : ["add-after", "reverse-order"].includes(scenario)
            ? "from A"
            : before;
      const result = { after: fs.readFileSync(h.inGame("config.ini"), "utf8") };
      expect(settledErrors).toEqual([]);
      expect(handlerCalls).toBe(1);
      expect.soft(work.length).toBe(expectedDirty ? 1 : 0);
      expect.soft(dirtyObserved).toBe(expectedDirty);
      expect.soft(actualDeploys).toBe(expectedDirty ? 2 : 1);
      expect.soft(result.after).toBe(expectedWinner);
      expect(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(false);
      expect(fs.readFileSync(path.join(h.stagingDir, "A", "config.ini"), "utf8")).toBe("from A");
      expect(fs.readFileSync(path.join(h.stagingDir, "B", "config.ini"), "utf8")).toBe("from B");
    } finally {
      nativeH.cleanup();
    }
  });
}

test("resolved reference cache keeps the deployed winner and clean state", async () => {
  await import("./index.js");
  expect(global.Promise).toBe(Bluebird);
  expect(Reflect.get(global.Promise, "withResolvers")).toBeUndefined();
  const options: IDeploymentOptions = {
    files: { "config.ini": "from A" },
    modName: "A",
    activeProfileId: "p",
    profiles: {
      p: makeProfile({
        id: "p",
        gameId: "skyrimse",
        modState: { A: { enabled: true, enabledTime: 0 }, B: { enabled: true, enabledTime: 0 } },
      }),
    },
    mods: {
      skyrimse: {
        A: makeMod({
          id: "A",
          installationPath: "A",
          rules: [{ type: "after", reference: { id: "B" } }],
        }),
        B: makeMod({ id: "B", installationPath: "B", rules: [] }),
      },
    },
  };
  const nativeH = makeDeploymentHarness(options);
  const work: PromiseLike<unknown>[] = [];
  const terminals: PromiseLike<unknown>[] = [];
  const active = new Set<PromiseLike<unknown>>();
  const errors: unknown[] = [];
  const retain = <T>(operation: PromiseLike<T>) => {
    work.push(operation);
    active.add(operation);
    terminals.push(
      Bluebird.resolve(operation).then(
        () => active.delete(operation),
        (error: unknown) => {
          active.delete(operation);
          errors.push(error);
        },
      ),
    );
    return operation;
  };
  const drain = async () => {
    let observed = -1;
    while (observed !== work.length) {
      observed = work.length;
      await Bluebird.all(
        [...work, ...terminals].map((operation) => Bluebird.resolve(operation).reflect()),
      );
      await new Bluebird<void>((resolve) => setImmediate(resolve));
    }
    await withActivationLock(() => Bluebird.resolve());
  };
  try {
    const h = {
      ...nativeH,
      ...makeApiHarness(options, [
        { path: ["persistent", "deployment"], reducer: deploymentReducer },
      ]),
    };
    fs.mkdirSync(path.join(h.stagingDir, "B"));
    fs.writeFileSync(path.join(h.stagingDir, "B", "config.ini"), "from B");
    h.setState((state) => {
      state.app = { ...state.app, instanceId: "rule-hints" };
      state.persistent.deployment.needToDeploy.skyrimse = false;
    });
    h.api.lookupModMeta = vi.fn<typeof h.api.lookupModMeta>().mockResolvedValue([]);
    const pendingCache: ReturnType<typeof cacheModReference>[] = [];
    let resolved = 0;
    setResolvedCB((gameId, modId, reference, refModId) => {
      resolved++;
      pendingCache.push(cacheModReference(gameId, modId, reference, refModId));
    });
    const perform = async () => {
      const ordered = await retain(
        sortMods("skyrimse", Object.values(h.getState().persistent.mods.skyrimse), h.api),
      );
      const manifest = await retain(
        deployMods(
          h.api,
          "skyrimse",
          h.stagingDir,
          h.gameDir,
          ordered,
          h.method,
          [],
          "",
          new BlacklistSet([], getGame("skyrimse"), h.normalize),
          () => "",
        ),
      );
      await retain(
        saveActivation(
          "skyrimse",
          "",
          "rule-hints",
          h.gameDir,
          h.stagingDir,
          manifest,
          h.method.id,
        ),
      );
      h.api.store.dispatch(setDeploymentNecessary("skyrimse", false));
    };
    await retain(perform());
    await drain();
    expect(resolved).toBe(1);
    expect(pendingCache).toHaveLength(1);
    const beforeRef = h.getState().persistent.mods.skyrimse.A.rules[0].reference;
    expect(beforeRef.idHint).toBeUndefined();
    expect(findModByRef(beforeRef, h.getState().persistent.mods.skyrimse).id).toBe("B");
    expect(fs.readFileSync(h.inGame("config.ini"), "utf8")).toBe("from A");
    let watcherCalls = 0;
    let dirtyCalls = 0;
    h.api.onStateChange(["persistent", "mods"], (previous, current) => {
      watcherCalls++;
      onModsChanged(h.api, previous, current);
    });
    h.api.onStateChange(["persistent", "deployment", "needToDeploy"], () => {
      dirtyCalls++;
    });
    for (const action of pendingCache.splice(0)) h.api.store.dispatch(action);
    await drain();
    const afterRef = h.getState().persistent.mods.skyrimse.A.rules[0].reference;
    expect(afterRef).toEqual({ ...beforeRef, idHint: "B" });
    expect(findModByRef(afterRef, h.getState().persistent.mods.skyrimse).id).toBe("B");
    expect(watcherCalls).toBe(1);
    expect.soft(dirtyCalls).toBe(0);
    expect.soft(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(false);
    expect(resolved).toBe(1);
    expect(pendingCache).toHaveLength(0);
    expect(active.size).toBe(0);
    expect(errors).toEqual([]);
    expect(fs.readFileSync(h.inGame("config.ini"), "utf8")).toBe("from A");
    expect(fs.statSync(h.inGame("config.ini")).ino).toBe(
      fs.statSync(path.join(h.stagingDir, "A", "config.ini")).ino,
    );
    expect(fs.readFileSync(path.join(h.stagingDir, "A", "config.ini"), "utf8")).toBe("from A");
    expect(fs.readFileSync(path.join(h.stagingDir, "B", "config.ini"), "utf8")).toBe("from B");
  } finally {
    await drain();
    setResolvedCB(undefined);
    nativeH.cleanup();
  }
});

for (const scenario of ["md5Hint", "reference", "top-level hints"] as const) {
  test(`rule comparison preserves substantive references: ${scenario}`, () => {
    const h = makeApiHarness(
      {
        activeProfileId: "p",
        profiles: { p: makeProfile({ id: "p", gameId: "skyrimse" }) },
      },
      [{ path: ["persistent", "deployment"], reducer: deploymentReducer }],
    );
    h.setState((state) => {
      state.persistent.deployment.needToDeploy.skyrimse = false;
    });
    const before = {
      skyrimse: { A: makeMod({ id: "A", rules: [{ type: "after", reference: { id: "B" } }] }) },
    };
    const rule: IModRule = {
      type: "after",
      reference: {
        id: scenario === "reference" ? "C" : "B",
        ...(scenario === "md5Hint" || scenario === "reference" ? { md5Hint: "cached digest" } : {}),
      },
      ...(scenario === "top-level hints" ? { idHint: "B", md5Hint: "cached digest" } : {}),
    };
    const after = { skyrimse: { A: makeMod({ id: "A", rules: [rule] }) } };
    onModsChanged(h.api, before, after);
    expect(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(scenario === "reference");
  });
}
