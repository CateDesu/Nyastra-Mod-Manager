import * as _ from "lodash";

import * as actions from "../../actions";
import { log } from "../../logging";
import type { IExtensionApi } from "../../types/IExtensionContext";
import { batchDispatch, toPromise } from "../../util/util";
import type { IMod, IModRule } from "../mod_management/types/IMod";
import { findModByRef } from "../mod_management/util/findModByRef";
import testModReference from "../mod_management/util/testModReference";
import {
  activeProfile,
  lastActiveProfileForGame,
  profileById,
} from "../profile_management/selectors";
import type { ICollection } from "./types/ICollection";
import type { IExtensionFeature } from "./util/extension";
import { findExtensions } from "./util/extension";
import { isGamebryoGame, parseGameSpecifics } from "./util/gameSupport";

const pendingGameSpecifics = new WeakMap<IExtensionApi, Map<string, () => Promise<void>>>();

function gameSpecificQueue(api: IExtensionApi): Map<string, () => Promise<void>> {
  let pending = pendingGameSpecifics.get(api);
  if (pending === undefined) {
    pending = new Map();
    pendingGameSpecifics.set(api, pending);
    api.events.on("profile-did-change", async () => {
      for (const finish of [...pending.values()]) {
        try {
          await finish();
        } catch (err) {
          api.showErrorNotification("Failed to apply collection rules", err);
        }
      }
    });
  }
  return pending;
}

function applyCollectionRules(
  api: IExtensionApi,
  gameId: string,
  collection: ICollection,
  mods: { [modId: string]: IMod },
) {
  const batch = (collection.modRules ?? []).reduce((prev, rule) => {
    const sourceMod = findModByRef(rule.source, mods);
    if (sourceMod !== undefined) {
      const destMod = findModByRef(rule.reference, mods);

      let exists: boolean = false;
      if (destMod !== undefined) {
        // replace existing rules between these two mods
        const exSourceRules = (sourceMod.rules ?? []).filter(
          (iter: IModRule) =>
            ["before", "after"].includes(iter.type) && testModReference(destMod, iter.reference),
        );
        exSourceRules.forEach((exSourceRule: IModRule) => {
          const copy = JSON.parse(JSON.stringify(exSourceRule));
          delete copy.reference.idHint;
          if (!exists && _.isEqual(copy, rule)) {
            exists = true;
          } else {
            prev.push(actions.removeModRule(gameId, sourceMod.id, exSourceRule));
          }
        });
        const exDestRules = (destMod.rules ?? []).filter(
          (iter: IModRule) =>
            ["before", "after"].includes(iter.type) && testModReference(sourceMod, iter.reference),
        );
        exDestRules.forEach((exDestRule: IModRule) => {
          prev.push(actions.removeModRule(gameId, destMod.id, exDestRule));
        });
        rule.reference = {
          id: destMod.id,
          idHint: destMod.id,
          archiveId: destMod.archiveId,
        };
      }

      if (!exists) {
        log("info", "add collection rule", {
          gameId,
          sourceMod: sourceMod.id,
          rule: JSON.stringify(rule),
        });
        prev.push(actions.addModRule(gameId, sourceMod.id, rule));
      }
    }
    return prev;
  }, []);

  batchDispatch(api.store, batch);
}

/**
 * postprocess a collection. This is called after dependencies for the pack have been installed.
 * It may get called multiple times so it has to take care to not break if any data already
 * exists
 */
export async function postprocessCollection(
  api: IExtensionApi,
  gameId: string,
  collectionMod: IMod,
  collection: ICollection,
  mods: { [modId: string]: IMod },
  ownerProfileId?: string,
  isCurrent: () => boolean = () => true,
) {
  log("info", "postprocess collection");
  const profileId = ownerProfileId ?? lastActiveProfileForGame(api.getState(), gameId);
  const ownsProfile = () =>
    isCurrent() &&
    profileId !== undefined &&
    profileById(api.getState(), profileId)?.gameId === gameId;
  if (!ownsProfile()) return;
  applyCollectionRules(api, gameId, collection, mods);
  try {
    // TODO: replace this with a call to the awaitModsDeployment API extension method
    await toPromise((cb) =>
      api.events.emit("deploy-mods", cb, profileId, undefined, {
        isCollectionPostprocessCall: true,
      }),
    );
  } catch (err) {
    log("warn", "Failed to deploy during collection post processing");
  }
  if (!ownsProfile()) return;

  const exts: IExtensionFeature[] = findExtensions(api.getState(), gameId);

  for (const ext of exts) {
    if (!ownsProfile()) return;
    await ext.parse(gameId, collection, collectionMod, profileId, ownsProfile);
    if (!ownsProfile()) return;
  }

  const pending = gameSpecificQueue(api);
  const key = JSON.stringify([profileId, collectionMod.id]);
  let running = false;
  const finish = async () => {
    if (pending.get(key) !== finish || running) return;
    if (!ownsProfile()) {
      pending.delete(key);
      return;
    }
    const canFinish = () =>
      activeProfile(api.getState())?.id === profileId ||
      !isGamebryoGame(gameId) ||
      api.getState()["userlist"] === undefined;
    if (!canFinish()) return;
    running = true;
    try {
      await parseGameSpecifics(
        api,
        gameId,
        collection,
        collectionMod,
        profileId,
        () => ownsProfile() && pending.get(key) === finish && canFinish(),
      );
      if (!ownsProfile() || !canFinish() || pending.get(key) !== finish) return;
      pending.delete(key);
      api.events.emit("collection-postprocess-complete", gameId, collectionMod.id, profileId);
    } finally {
      running = false;
    }
  };
  pending.set(key, finish);
  await finish();
}
