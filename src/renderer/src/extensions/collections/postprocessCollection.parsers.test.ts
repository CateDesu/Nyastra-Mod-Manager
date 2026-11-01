import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, vi } from "vitest";

import { loReducer } from "../../reducers/loadOrder";
import { makeApiHarness, makeLoadOrder, makeMod, makeProfile } from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fsUtil from "../../util/fs";
import { getSafe } from "../../util/storeHelper";
import { parser as parseFiles } from "../file_based_loadorder/collections/loadOrder";
import initGeneric from "../mod_load_order/index";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { postprocessCollection } from "./postprocessCollection";
import { addExtension, type IExtensionFeature } from "./util/extension";
import { parser as parsePlugins } from "./util/gameSupport/gamebryo";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const a = makeProfile({ id: "parser-a", gameId: "skyrimse" });
  const b = makeProfile({ id: "parser-b", gameId: a.gameId });
  const mod = makeMod({ id: "collection", type: "collection", rules: [] });
  const h = makeApiHarness(
    {
      profiles: { [a.id]: a, [b.id]: b },
      activeProfileId: a.id,
      lastActiveProfile: { [a.gameId]: a.id },
    },
    [
      { path: ["persistent", "profiles"], reducer: profilesReducer },
      { path: ["persistent", "loadOrder"], reducer: loReducer },
    ],
  );
  const collection = {
    info: {
      author: "Fixture",
      authorUrl: "",
      name: "Fixture",
      description: "",
      installInstructions: "",
      domainName: "skyrimspecialedition",
    },
    mods: [],
    modRules: [],
    loadOrder: makeLoadOrder("incoming"),
  };
  const activate = (id: string) =>
    h.setState((state) => {
      state.settings.profiles.activeProfileId = id;
      state.settings.profiles.lastActiveProfile[a.gameId] = id;
    });
  return { ...h, a, b, mod, collection, activate };
}

test("registered generic parser receives the completion owner and keeps legacy calls", async () => {
  const h = fixture();
  let parse: IExtensionFeature["parse"];
  const context = new Proxy(
    {
      api: h.api,
      optional: {
        registerCollectionFeature: (_id, _generate, parser) => {
          parse = parser;
        },
      },
    },
    { get: (target, key) => (key in target ? target[key] : () => undefined) },
  );
  initGeneric(context as unknown as IExtensionContext);
  h.activate(h.b.id);
  await parse(h.a.gameId, h.collection, h.mod, h.a.id);
  expect(getSafe(h.getState(), ["persistent", "loadOrder", h.a.id], [])).toEqual(
    h.collection.loadOrder,
  );
  expect(getSafe(h.getState(), ["persistent", "loadOrder", h.b.id], [])).toEqual([]);
  expect(h.dispatched.filter((action) => action.type === "SET_LOAD_ORDER").at(-1)?.payload).toEqual(
    { id: h.a.id, order: h.collection.loadOrder },
  );
  await parse(h.a.gameId, h.collection, h.mod);
  expect(h.dispatched.filter((action) => action.type === "SET_LOAD_ORDER").at(-1)?.payload).toEqual(
    { id: h.b.id, order: h.collection.loadOrder },
  );
  h.setState((state) => {
    state.persistent.profiles[h.a.id].gameId = "other-game";
  });
  const count = h.dispatched.length;
  await expect(parse(h.b.gameId, h.collection, h.mod, h.a.id)).rejects.toThrow(
    "Invalid profile id",
  );
  expect(h.dispatched).toHaveLength(count);
});

for (const change of ["remove", "change-game"] as const) {
  test(`file parser validates its captured owner after its async boundary: ${change}`, async () => {
    const h = fixture();
    const work = parseFiles(h.api, [], h.a.gameId, h.collection as never, h.a.id);
    h.setState((state) => {
      if (change === "remove") delete state.persistent.profiles[h.a.id];
      else state.persistent.profiles[h.a.id].gameId = "other-game";
    });
    await expect(work).rejects.toThrow("Invalid profile id");
    expect(h.dispatched.filter((action) => action.type === "SET_FB_LOAD_ORDER")).toEqual([]);
  });

  for (const boundary of ["deploy", "parser"] as const) {
    test(`postprocess stops when its owner changes during ${boundary}: ${change}`, async () => {
      const h = fixture();
      const entered = deferred();
      const release = deferred();
      let enabled = true;
      const next = vi.fn(async () => undefined);
      const prefix = `${change}-${boundary}`;
      addExtension({
        id: prefix,
        generate: async () => ({}),
        clone: async () => undefined,
        title: () => "Fixture",
        condition: () => enabled,
        parse: async () => {
          if (boundary === "parser") {
            entered.resolve();
            await release.promise;
          }
        },
      });
      addExtension({
        id: prefix + "-next",
        generate: async () => ({}),
        clone: async () => undefined,
        title: () => "Fixture",
        condition: () => enabled,
        parse: next,
      });
      h.api.events.on("deploy-mods", (cb) => {
        if (boundary === "deploy") {
          entered.resolve();
          void release.promise.then(() => cb(null));
        } else cb(null);
      });
      const complete = vi.fn();
      h.api.events.on("collection-postprocess-complete", complete);
      const work = postprocessCollection(h.api, h.a.gameId, h.mod, h.collection, {}, h.a.id);
      try {
        await entered.promise;
        h.setState((state) => {
          if (change === "remove") delete state.persistent.profiles[h.a.id];
          else state.persistent.profiles[h.a.id].gameId = "other-game";
        });
        release.resolve();
        await work;
        expect(next).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        expect(h.errorNotifications).toEqual([]);
      } finally {
        release.resolve();
        await work;
        enabled = false;
      }
    });
  }
}

test("gamebryo skips global plugin writes after a profile switch during real staging reads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collection-plugins-"));
  const h = fixture();
  const entered = deferred();
  const release = deferred();
  await fs.mkdir(path.join(root, "member"));
  await fs.writeFile(path.join(root, "member", "Member.esp"), "real plugin bytes");
  const member = makeMod({ id: "member", installationPath: "member" });
  h.mod.rules = [{ type: "requires", reference: { id: member.id } }];
  h.setState((state) => {
    state.settings.mods.installPath[h.a.gameId] = root;
    state.persistent.mods[h.a.gameId] = { member, [h.mod.id]: h.mod };
    Object.assign(state, { userlist: { plugins: [], groups: [] } });
    Object.assign(state.session, { notifications: { notifications: [] } });
  });
  const readdir = fsUtil.readdirAsync;
  vi.spyOn(fsUtil, "readdirAsync").mockImplementation((directory) =>
    readdir(directory).then((files) => {
      entered.resolve();
      return release.promise.then(() => files);
    }),
  );
  const work = parsePlugins(h.api, h.a.gameId, h.collection, h.mod, h.a.id);
  try {
    await entered.promise;
    h.activate(h.b.id);
    release.resolve();
    await work;
    expect(h.dispatched.filter((action) => action.type === "SET_PLUGIN_ENABLED")).toEqual([]);
    expect(await fs.readFile(path.join(root, "member", "Member.esp"), "utf8")).toBe(
      "real plugin bytes",
    );
  } finally {
    release.resolve();
    await work;
    await fs.rm(root, { recursive: true, force: true });
  }
});
