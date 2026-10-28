import { afterEach, expect, it, vi } from "vitest";

import {
  makeApiHarness,
  makeMod,
  makeProfile,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import { forgetMod, setModEnabled } from "../profile_management/actions/profiles";
import { profilesReducer } from "../profile_management/reducers/profiles";
import init from "./index";

afterEach(() => {
  resetHarnessRegistries();
  vi.restoreAllMocks();
});

function setup(tracked: boolean) {
  const harness = makeApiHarness(
    {
      profiles: {
        p: makeProfile({
          id: "p",
          gameId: "game",
          modState: tracked ? { sticky: { enabled: false, enabledTime: 1 } } : {},
        }),
      },
      mods: {
        game: {
          sticky: makeMod({ id: "sticky", attributes: { sticky: true, name: "Save-bound mod" } }),
          normal: makeMod({ id: "normal", attributes: { name: "Ordinary mod" } }),
        },
      },
    },
    [{ path: ["persistent", "profiles"], reducer: profilesReducer }],
  );
  init({ api: harness.api, once: (callback) => callback() } as IExtensionContext);
  return harness;
}

it.each([false, true])(
  "warns when a sticky mod is enabled with an existing entry of %s",
  (tracked) => {
    const h = setup(tracked);
    const translate = vi.spyOn(h.api, "translate");
    h.api.store.dispatch(setModEnabled("p", "sticky", true));
    expect(h.notifications).toEqual([
      expect.objectContaining({ type: "warning", message: expect.stringContaining("sticky") }),
    ]);
    expect(translate).toHaveBeenCalledWith(expect.any(String), {
      replace: { modName: "Save-bound mod" },
    });
    h.api.store.dispatch(setModEnabled("p", "sticky", true));
    h.api.store.dispatch(setModEnabled("p", "normal", true));
    expect(h.notifications).toHaveLength(1);
  },
);

it("forgets a sticky mod without throwing or warning", () => {
  const h = setup(true);
  expect(() => h.api.store.dispatch(forgetMod("p", "sticky"))).not.toThrow();
  expect(h.getState().persistent.profiles.p.modState).toEqual({});
  expect(h.notifications).toEqual([]);
});

it("warns only for the changed profile's game", () => {
  const h = setup(false);
  h.setState((state) => {
    state.persistent.profiles.other = makeProfile({ id: "other", gameId: "other", modState: {} });
    state.persistent.mods.other = {
      sticky: makeMod({ id: "sticky", attributes: { sticky: false } }),
    };
  });
  h.api.store.dispatch(setModEnabled("other", "sticky", true));
  expect(h.notifications).toEqual([]);
  h.api.store.dispatch(setModEnabled("p", "sticky", true));
  expect(h.notifications).toHaveLength(1);
});
