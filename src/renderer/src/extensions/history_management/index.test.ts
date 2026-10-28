import { expect, it } from "vitest";

import { makeApiHarness } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import { addHistoryEvent } from "./actions";
import init from "./index";
import { persistentReducer, sessionReducer } from "./reducers";
import type { IHistoryEvent } from "./types";

it("allows retry after reverting an event fails with the original dialog event", () => {
  const h = makeApiHarness({}, [
    { path: ["persistent", "history"], reducer: persistentReducer },
    { path: ["session", "history"], reducer: sessionReducer },
  ]);
  let props: () => {
    onReverted: (stackId: string, event: IHistoryEvent) => void;
    onError: (error: Error, stackId: string, event: IHistoryEvent) => void;
  };
  const context: Partial<IExtensionContext> = {
    api: h.api,
    registerDialog: (_id, _component, makeProps) => {
      props = makeProps as typeof props;
    },
  };
  init(
    new Proxy(context, {
      get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
    }) as IExtensionContext,
  );
  h.api.store.dispatch(
    addHistoryEvent(
      "mods",
      { id: "retry", gameId: "game", type: "test", data: "retryable", reverted: false },
      2,
    ),
  );
  const dialogEvent = h.getState().persistent.history.historyStacks.mods[0];
  props().onReverted("mods", dialogEvent);
  expect(h.getState().persistent.history.historyStacks.mods[0].reverted).toBe(true);
  const failure = new Error("fixture revert failed");
  props().onError(failure, "mods", dialogEvent);
  expect(h.errorNotifications).toEqual([
    expect.objectContaining({ title: "Failed to revert event", message: failure }),
  ]);
  expect(h.getState().persistent.history.historyStacks.mods[0].reverted).toBe(false);
  props().onReverted("mods", h.getState().persistent.history.historyStacks.mods[0]);
  expect(h.getState().persistent.history.historyStacks.mods[0].reverted).toBe(true);
});
