import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, vi } from "vitest";

import { loReducer } from "../../reducers/loadOrder";
import { makeApiHarness, makeLoadOrder, makeMod, makeProfile } from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fsUtil from "../../util/fs";
import { setFBLoadOrder } from "../file_based_loadorder/actions/loadOrder";
import { parser as parseFiles } from "../file_based_loadorder/collections/loadOrder";
import initFiles from "../file_based_loadorder/index";
import { REDUCER_BINDINGS } from "../file_based_loadorder/reducers/bindings";
import { loadOrderForProfile } from "../file_based_loadorder/selectors";
import initGeneric from "../mod_load_order/index";
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
  const profile = makeProfile({ id: "retirement-a", gameId: "skyrimse" });
  const mod = makeMod({ id: "collection", type: "collection", rules: [] });
  const h = makeApiHarness(
    {
      profiles: { [profile.id]: profile },
      activeProfileId: profile.id,
      lastActiveProfile: { [profile.gameId]: profile.id },
    },
    [...REDUCER_BINDINGS, { path: ["persistent", "loadOrder"], reducer: loReducer }],
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
  return { ...h, profile, mod, collection };
}

for (const kind of ["file", "generic"] as const) {
  for (const retired of [false, true]) {
    test(`registered ${kind} parser honors optional retirement: ${retired}`, async () => {
      const h = fixture();
      let parse!: IExtensionFeature["parse"];
      const context = new Proxy(
        {
          api: h.api,
          optional: {
            registerCollectionFeature: (_id, _generate, parser) => {
              parse = parser;
            },
          },
        },
        { get: (obj, key) => (key in obj ? obj[key] : () => undefined) },
      ) as unknown as IExtensionContext;
      if (kind === "file") initFiles(context);
      else initGeneric(context);
      let current = kind === "generic" ? !retired : true;
      const work = parse(h.profile.gameId, h.collection, h.mod, h.profile.id, () => current);
      current = !retired;
      await work;
      expect(
        h.dispatched.filter(
          (action) => action.type === (kind === "file" ? "SET_FB_LOAD_ORDER" : "SET_LOAD_ORDER"),
        ),
      ).toHaveLength(retired ? 0 : 1);
      // Manual Apply Collection Rules calls may omit the predicate.
      await parse(h.profile.gameId, h.collection, h.mod, h.profile.id);
      expect(loadOrderForProfile(h.getState(), h.profile.id)).toEqual(h.collection.loadOrder);
    });
  }
}

for (const retired of [false, true]) {
  test(`retirement during an extension parser stops subsequent effects: ${retired}`, async () => {
    const h = fixture();
    const entered = deferred();
    const release = deferred();
    let enabled = true;
    let current = true;
    const next = vi.fn<IExtensionFeature["parse"]>((gameId, collection, _mod, owner, isCurrent) =>
      parseFiles(h.api, [], gameId, collection as never, owner, isCurrent),
    );
    addExtension({
      id: `retire-first-${retired}`,
      generate: async () => ({}),
      clone: async () => undefined,
      title: () => "Fixture",
      condition: () => enabled,
      parse: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    addExtension({
      id: `retire-next-${retired}`,
      generate: async () => ({}),
      clone: async () => undefined,
      title: () => "Fixture",
      condition: () => enabled,
      parse: next,
    });
    const deployment = vi.fn((cb) => cb(null));
    h.api.events.on("deploy-mods", deployment);
    const complete = vi.fn();
    h.api.events.on("collection-postprocess-complete", complete);
    const work = postprocessCollection(
      h.api,
      h.profile.gameId,
      h.mod,
      h.collection,
      {},
      h.profile.id,
      () => current,
    );
    try {
      await entered.promise;
      current = !retired;
      release.resolve();
      await work;
      expect(next).toHaveBeenCalledTimes(retired ? 0 : 1);
      expect(loadOrderForProfile(h.getState(), h.profile.id)).toEqual(
        retired ? [] : h.collection.loadOrder,
      );
      expect(complete).toHaveBeenCalledTimes(retired ? 0 : 1);
      expect(deployment).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await work;
      enabled = false;
    }
  });
}

for (const retired of [false, true]) {
  test(`Gamebryo staging scan checks retirement before plugin effects: ${retired}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "retired-plugin-scan-"));
    const h = fixture();
    const entered = deferred();
    const release = deferred();
    let current = true;
    const member = makeMod({ id: "member", installationPath: "member" });
    h.mod.rules = [{ type: "requires", reference: { id: member.id } }];
    h.setState((state) => {
      state.settings.mods.installPath[h.profile.gameId] = root;
      state.persistent.mods[h.profile.gameId] = { [h.mod.id]: h.mod, member };
      Object.assign(state, { userlist: { plugins: [], groups: [] } });
      Object.assign(state.session, { notifications: { notifications: [] } });
    });
    await fs.mkdir(path.join(root, "member"));
    await fs.writeFile(path.join(root, "member", "Member.esp"), "real plugin bytes");
    const readdir = fsUtil.readdirAsync;
    let scans = 0;
    vi.spyOn(fsUtil, "readdirAsync").mockImplementation((directory) =>
      readdir(directory).then((files) => {
        scans++;
        entered.resolve();
        return release.promise.then(() => files);
      }),
    );
    const work = parsePlugins(
      h.api,
      h.profile.gameId,
      h.collection,
      h.mod,
      h.profile.id,
      () => current,
    );
    try {
      await entered.promise;
      current = !retired;
      const manual = makeLoadOrder("later-manual");
      h.api.store.dispatch(setFBLoadOrder(h.profile.id, manual));
      release.resolve();
      await work;
      expect(scans).toBe(1);
      expect(h.dispatched.filter((action) => action.type === "SET_PLUGIN_ENABLED")).toHaveLength(
        retired ? 0 : 1,
      );
      expect(loadOrderForProfile(h.getState(), h.profile.id)).toEqual(manual);
      expect(await fs.readFile(path.join(root, "member", "Member.esp"), "utf8")).toBe(
        "real plugin bytes",
      );
    } finally {
      release.resolve();
      await work;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
