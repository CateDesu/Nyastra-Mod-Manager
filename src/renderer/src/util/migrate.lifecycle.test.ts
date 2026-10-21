import type { Store } from "redux";
import { afterEach, expect, it, vi } from "vitest";

import { setForcedLogout } from "../actions";
import { appReducer } from "../reducers/app";
import type { IState } from "../types/IState";
import migrate from "./migrate";

afterEach(() => vi.clearAllMocks());

it.each([true, false])(
  "skips historical migrations for a fresh profile, explicit prior version: %s",
  async (explicit) => {
    const dispatch = vi.fn();
    const store = {
      getState: () => ({ app: { ...appReducer.defaults, appVersion: explicit ? "2.9.1" : "" } }),
      dispatch,
    } as unknown as Store<IState>;

    await migrate(store, explicit ? "" : undefined);

    expect(dispatch).not.toHaveBeenCalled();
  },
);

it("logs out an old profile without sending credentials to the logging IPC boundary", async () => {
  const dispatch = vi.fn();
  const store = {
    getState: () => ({
      app: {
        ...appReducer.defaults,
        appVersion: "1.8.0",
        migrations: ["enableModernLayout_2_0", "moveDomainFolders_2_1", "healStoragePathNames_2_4"],
      },
      confidential: {
        account: {
          nexus: {
            APIKey: "synthetic-key-must-stay-private",
            OAuthCredentials: { token: "synthetic-token-must-stay-private" },
          },
        },
      },
    }),
    dispatch,
  } as unknown as Store<IState>;

  await migrate(store, "1.8.0");

  expect(dispatch).toHaveBeenCalledWith(setForcedLogout(true));
  expect(window.api.log).toHaveBeenCalled();
  const serializedLogs = JSON.stringify(vi.mocked(window.api.log).mock.calls);
  expect(serializedLogs).not.toContain("synthetic-key-must-stay-private");
  expect(serializedLogs).not.toContain("synthetic-token-must-stay-private");
});
