import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";

import {
  setEnabledModsBeforeDisable,
  setModsEnabled,
} from "../../profile_management/actions/profiles";
import { activeProfile } from "../../profile_management/selectors";

export type ProfileModChange = "disable" | "restore" | "enable";

const running = new WeakSet<IExtensionApi>();

export const modEnableControlsBlocked = (state: IState): boolean => {
  const profile = activeProfile(state);
  if (profile === undefined) {
    return true;
  }
  const activity = state.session.base?.activity;
  const tasks = [
    "conflicts",
    "installing_dependencies",
    "deployment",
    "deployment_pending",
    "purging",
  ];
  return (
    tasks.some((task) => activity?.mods?.includes(task) || (activity?.[task]?.length ?? 0) > 0) ||
    state.session.collections?.activeSession != null ||
    (state.settings.profiles.nextProfileId !== undefined &&
      state.settings.profiles.nextProfileId !== profile.id) ||
    Object.values(state.persistent.mods[profile.gameId] ?? {}).some(
      (mod) => mod.state === "installing",
    )
  );
};

/** Changes installed mods through the normal hooks and deployment notifications. */
export async function changeProfileMods(
  api: IExtensionApi,
  profileId: string,
  change: ProfileModChange,
): Promise<boolean> {
  const state = api.getState();
  const profile = activeProfile(state);
  if (running.has(api) || modEnableControlsBlocked(state) || profile?.id !== profileId) {
    return false;
  }

  running.add(api);
  try {
    const mods = state.persistent.mods[profile.gameId] ?? {};
    const installed = Object.keys(mods).filter((id) => mods[id].state === "installed");
    const saved = profile.enabledModsBeforeDisable;
    const enabled = change !== "disable";
    let modIds: string[];

    if (change === "restore") {
      if (saved === undefined) {
        return false;
      }
      modIds = saved.filter((id) => mods[id]?.state === "installed");
    } else {
      modIds = installed;
      if (change === "disable" && saved === undefined) {
        const toRemember = installed.filter((id) => profile.modState?.[id]?.enabled === true);
        if (toRemember.length > 0) {
          // Save before hooks run so a failed or interrupted disable remains recoverable.
          api.store.dispatch(setEnabledModsBeforeDisable(profileId, toRemember));
        }
      }
    }

    await setModsEnabled(api, profileId, modIds, enabled);

    const current = api.getState();
    const currentProfile = current.persistent.profiles[profileId];
    if (currentProfile === undefined) {
      return false;
    }
    const currentMods = current.persistent.mods[profile.gameId] ?? {};
    const completed = modIds.every(
      (id) =>
        currentMods[id]?.state !== "installed" ||
        (currentProfile.modState?.[id]?.enabled ?? false) === enabled,
    );
    if (completed && change !== "disable" && currentProfile.enabledModsBeforeDisable === saved) {
      api.store.dispatch(setEnabledModsBeforeDisable(profileId, undefined));
    }
    return completed;
  } finally {
    running.delete(api);
  }
}
