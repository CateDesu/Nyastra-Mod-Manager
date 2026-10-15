import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verify } from "@/reducers/verify";
import { makeApiHarness, makeMod, makeProfile } from "@/test-utils/builders";
import type { IExtensionApi } from "@/types/IExtensionContext";

import {
  setEnabledModsBeforeDisable,
  setModEnabled,
} from "../../../profile_management/actions/profiles";
import { setNextProfile } from "../../../profile_management/actions/settings";
import { profilesReducer } from "../../../profile_management/reducers/profiles";
import { settingsReducer } from "../../../profile_management/reducers/settings";
import { changeProfileMods, modEnableControlsBlocked } from "../../util/changeProfileMods";
import { ModEnableControls } from "./ModEnableControls";

let harness: ReturnType<typeof makeApiHarness>;
let beforeChange: () => Promise<void>;
let afterChange: () => Promise<void>;
const showErrorNotification = vi.fn();
const api = {
  getState: () => harness.api.getState(),
  get store() {
    return harness.api.store;
  },
  get events() {
    return harness.api.events;
  },
  showErrorNotification,
  withPrePost:
    (_event, callback) =>
    async (...args) => {
      await beforeChange();
      const result = await callback(...args);
      await afterChange();
      return result;
    },
} satisfies Partial<IExtensionApi> as unknown as IExtensionApi;

vi.mock("@/contexts", () => ({ useMainContext: () => ({ api }) }));

const currentProfile = () => api.getState().persistent.profiles.p;
const isEnabled = (id: string) => currentProfile().modState[id]?.enabled === true;
const saved = () => currentProfile().enabledModsBeforeDisable;
const openMenu = async () => {
  await userEvent.click(screen.getByTestId("mod-enable-controls"));
  return within(screen.getByRole("menu"));
};

beforeEach(() => {
  beforeChange = () => Promise.resolve();
  afterChange = () => Promise.resolve();
  showErrorNotification.mockClear();
  harness = makeApiHarness(
    {
      activeProfileId: "p",
      profiles: {
        p: makeProfile({
          id: "p",
          gameId: "game",
          modState: {
            a: { enabled: true, enabledTime: 1 },
            b: { enabled: false, enabledTime: 2 },
            c: { enabled: true, enabledTime: 3 },
            archive: { enabled: false, enabledTime: 0 },
            removed: { enabled: true, enabledTime: 0 },
          },
        }),
        other: makeProfile({
          id: "other",
          gameId: "game",
          modState: {
            b: { enabled: true, enabledTime: 0 },
          },
        }),
      },
      mods: {
        game: {
          a: makeMod({ id: "a", state: "installed" }),
          b: makeMod({ id: "b", state: "installed" }),
          c: makeMod({ id: "c", state: "installed" }),
          archive: makeMod({ id: "archive", state: "downloaded" }),
        },
      },
    },
    [
      { path: ["persistent", "profiles"], reducer: profilesReducer },
      { path: ["settings", "profiles"], reducer: settingsReducer },
    ],
  );
});

describe("profile mod controls", () => {
  it("disables installed mods and restores only the ones that were enabled", async () => {
    const other = api.getState().persistent.profiles.other;
    const emit = vi.spyOn(api.events, "emit");
    expect(await changeProfileMods(api, "p", "disable")).toBe(true);
    expect(saved()).toEqual(["a", "c"]);
    expect([isEnabled("a"), isEnabled("b"), isEnabled("c")]).toEqual([false, false, false]);
    expect(emit).toHaveBeenCalledWith("mods-enabled", ["a", "c"], false, "game", undefined);

    expect(await changeProfileMods(api, "p", "restore")).toBe(true);
    expect([isEnabled("a"), isEnabled("b"), isEnabled("c")]).toEqual([true, false, true]);
    expect(saved()).toBeUndefined();
    expect(isEnabled("archive")).toBe(false);
    expect(api.getState().persistent.profiles.other).toBe(other);
  });

  it("preserves the first snapshot when Disable all is repeated", async () => {
    await changeProfileMods(api, "p", "disable");
    api.store.dispatch(setModEnabled("p", "b", true));
    await changeProfileMods(api, "p", "disable");
    expect(saved()).toEqual(["a", "c"]);
    await changeProfileMods(api, "p", "restore");
    expect(isEnabled("b")).toBe(false);
  });

  it("keeps later manual enables when restoring the remembered mods", async () => {
    await changeProfileMods(api, "p", "disable");
    api.store.dispatch(setModEnabled("p", "b", true));
    await changeProfileMods(api, "p", "restore");
    expect(isEnabled("b")).toBe(true);
  });

  it("restores after serializing and hydrating the profile state", async () => {
    await changeProfileMods(api, "p", "disable");
    const persisted = JSON.parse(JSON.stringify(api.getState().persistent.profiles));
    harness.setState((state) => {
      state.persistent.profiles = persisted;
    });
    await changeProfileMods(api, "p", "restore");
    expect([isEnabled("a"), isEnabled("b"), isEnabled("c")]).toEqual([true, false, true]);
  });

  it("never recreates a removed mod or installs an archive during restore", async () => {
    await changeProfileMods(api, "p", "disable");
    harness.setState((state) => {
      delete state.persistent.mods.game.c;
      state.persistent.mods.game.a.state = "downloaded";
    });
    const emit = vi.spyOn(api.events, "emit");
    await changeProfileMods(api, "p", "restore");
    expect(emit).not.toHaveBeenCalled();
    expect(isEnabled("a")).toBe(false);
    expect(isEnabled("c")).toBe(false);
    expect(saved()).toBeUndefined();
  });

  it("enables all installed mods explicitly and finishes the saved cycle", async () => {
    await changeProfileMods(api, "p", "disable");
    expect(await changeProfileMods(api, "p", "enable")).toBe(true);
    expect([isEnabled("a"), isEnabled("b"), isEnabled("c")]).toEqual([true, true, true]);
    expect(isEnabled("archive")).toBe(false);
    expect(saved()).toBeUndefined();
  });

  it("does not create a snapshot when no installed mods are enabled", async () => {
    api.store.dispatch(setModEnabled("p", "a", false));
    api.store.dispatch(setModEnabled("p", "c", false));
    await changeProfileMods(api, "p", "disable");
    expect(saved()).toBeUndefined();
    expect(await changeProfileMods(api, "p", "restore")).toBe(false);
  });

  it("retains recovery data when a hook refuses a change, then permits retry", async () => {
    await changeProfileMods(api, "p", "disable");
    beforeChange = () => Promise.reject(new Error("extension refused"));
    expect(await changeProfileMods(api, "p", "restore")).toBe(false);
    expect(saved()).toEqual(["a", "c"]);
    expect(showErrorNotification).toHaveBeenCalled();
    beforeChange = () => Promise.resolve();
    expect(await changeProfileMods(api, "p", "restore")).toBe(true);
  });

  it("saves recovery data before disable hooks can fail", async () => {
    beforeChange = () => Promise.reject(new Error("extension refused"));
    expect(await changeProfileMods(api, "p", "disable")).toBe(false);
    expect(saved()).toEqual(["a", "c"]);
    expect(isEnabled("a")).toBe(true);
  });

  it("ignores overlapping clicks until the first change completes", async () => {
    let release: () => void;
    beforeChange = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const disabling = changeProfileMods(api, "p", "disable");
    expect(await changeProfileMods(api, "p", "enable")).toBe(false);
    release();
    await disabling;
    expect(isEnabled("a")).toBe(false);
    expect(saved()).toEqual(["a", "c"]);
  });

  it("does not apply a stale click to a different active profile", async () => {
    harness.setState((state) => {
      state.settings.profiles.activeProfileId = "other";
    });
    expect(await changeProfileMods(api, "p", "disable")).toBe(false);
    expect(isEnabled("a")).toBe(true);
    expect(saved()).toBeUndefined();
  });

  it.each(["deployment", "deployment_pending", "purging", "conflicts", "installing_dependencies"])(
    "blocks changes during %s",
    async (task) => {
      harness.setState((state) => {
        state.session.base = { activity: { mods: [task] } } as never;
      });
      expect(modEnableControlsBlocked(api.getState())).toBe(true);
      expect(await changeProfileMods(api, "p", "disable")).toBe(false);
      expect(isEnabled("a")).toBe(true);
    },
  );

  it("blocks changes while a profile switch or installation is running", async () => {
    api.store.dispatch(setNextProfile("other"));
    expect(await changeProfileMods(api, "p", "disable")).toBe(false);
    api.store.dispatch(setNextProfile(undefined));
    harness.setState((state) => {
      state.persistent.mods.game.b.state = "installing";
    });
    expect(await changeProfileMods(api, "p", "disable")).toBe(false);
  });

  it("keeps independent snapshots per profile", async () => {
    await changeProfileMods(api, "p", "disable");
    harness.setState((state) => {
      state.settings.profiles.activeProfileId = "other";
      state.settings.profiles.nextProfileId = "other";
    });
    await changeProfileMods(api, "other", "disable");
    expect(api.getState().persistent.profiles.other.enabledModsBeforeDisable).toEqual(["b"]);
    await changeProfileMods(api, "other", "restore");
    expect(saved()).toEqual(["a", "c"]);
    expect(isEnabled("a")).toBe(false);
  });

  it("completes a large list across the existing batched dispatch boundary", async () => {
    harness.setState((state) => {
      for (let i = 0; i < 1500; i++) {
        const id = `large-${i}`;
        state.persistent.mods.game[id] = makeMod({ id, state: "installed" });
        state.persistent.profiles.p.modState[id] = { enabled: true, enabledTime: 0 };
      }
    });
    expect(await changeProfileMods(api, "p", "disable")).toBe(true);
    expect(saved()).toHaveLength(1502);
    expect(await changeProfileMods(api, "p", "restore")).toBe(true);
    expect(isEnabled("large-1499")).toBe(true);
    expect(isEnabled("b")).toBe(false);
  });

  it.each([null, "bad", [1], ["a", null]])(
    "drops malformed saved state %j on hydration",
    (value) => {
      const input = { p: { ...currentProfile(), enabledModsBeforeDisable: value } };
      const result = verify("profiles", profilesReducer.verifiers, input, {}, () => undefined);
      expect(result.p.enabledModsBeforeDisable).toBeUndefined();
      expect(result.p.modState).toEqual(currentProfile().modState);
    },
  );

  it("does not mint a deleted profile when saving a snapshot", () => {
    api.store.dispatch(setEnabledModsBeforeDisable("missing", ["a"]));
    expect(api.getState().persistent.profiles.missing).toBeUndefined();
  });
});

describe("Mods on/off menu", () => {
  const renderControls = () =>
    render(
      <Provider store={api.store}>
        <ModEnableControls />
      </Provider>,
    );

  it("disables and restores through the real actions and profile reducer", async () => {
    renderControls();
    let menu = await openMenu();
    let items = menu.getAllByRole("menuitem");
    expect(items[1]).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(items[0]);
    expect(saved()).toEqual(["a", "c"]);
    expect(isEnabled("a")).toBe(false);
    menu = await openMenu();
    items = menu.getAllByRole("menuitem");
    await userEvent.click(items[1]);
    expect([isEnabled("a"), isEnabled("b"), isEnabled("c")]).toEqual([true, false, true]);
  });

  it("offers a separate Enable all action", async () => {
    renderControls();
    const menu = await openMenu();
    await userEvent.click(menu.getAllByRole("menuitem")[2]);
    expect([isEnabled("a"), isEnabled("b"), isEnabled("c")]).toEqual([true, true, true]);
    expect(isEnabled("archive")).toBe(false);
  });

  it("disables controls while an operation is pending", async () => {
    let release: () => void;
    beforeChange = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    renderControls();
    const menu = await openMenu();
    await userEvent.click(menu.getAllByRole("menuitem")[0]);
    expect(screen.getByTestId("mod-enable-controls")).toBeDisabled();
    await act(async () => {
      release();
    });
    expect(screen.getByTestId("mod-enable-controls")).not.toBeDisabled();
  });

  it("disables the menu when there is no active profile", () => {
    harness.setState((state) => {
      state.settings.profiles.activeProfileId = undefined;
    });
    renderControls();
    expect(screen.getByTestId("mod-enable-controls")).toBeDisabled();
  });
});
