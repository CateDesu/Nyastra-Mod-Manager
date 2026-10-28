import { expect, it } from "vitest";

import { makeApiHarness } from "../../test-utils/builders";
import { addHistoryEvent, markHistoryReverted, setHistoryEvent } from "./actions";
import { persistentReducer } from "./reducers";

it.each([0, 1, 2])(
  "retains only the registered number of most recent history events with limit %s",
  (limit) => {
    const h = makeApiHarness({}, [{ path: ["persistent", "history"], reducer: persistentReducer }]);
    for (let index = 0; index < 5; index++) {
      h.api.store.dispatch(
        addHistoryEvent(
          "mods",
          { id: `event-${index}`, type: "test", gameId: "game", data: index },
          limit,
        ),
      );
    }
    expect(h.getState().persistent.history.historyStacks.mods.map((event) => event.id)).toEqual(
      Array.from({ length: limit }, (_, index) => `event-${5 - limit + index}`),
    );
  },
);

it("ignores late history updates for an event evicted while its work ran", () => {
  const h = makeApiHarness({}, [{ path: ["persistent", "history"], reducer: persistentReducer }]);
  const removed = { id: "evicted", type: "test", gameId: "game", data: "old" };
  for (let index = 0; index < 5; index++) {
    h.api.store.dispatch(
      addHistoryEvent("mods", { ...removed, id: `current-${index}`, data: index }, 2),
    );
  }
  const before = h.getState().persistent.history;
  h.api.store.dispatch(markHistoryReverted("mods", removed));
  h.api.store.dispatch(setHistoryEvent("mods", removed));
  expect(Object.hasOwn(h.getState().persistent.history.historyStacks.mods, "-1")).toBe(false);
  expect(h.getState().persistent.history).toBe(before);
  h.api.store.dispatch(markHistoryReverted("mods", { ...removed, id: "current-4" }));
  expect(h.getState().persistent.history.historyStacks.mods.at(-1)?.reverted).toBe(true);
});

it("updates a retained event without changing its neighbors", () => {
  const h = makeApiHarness({}, [{ path: ["persistent", "history"], reducer: persistentReducer }]);
  const first = { id: "first", type: "test", gameId: "game", data: "original" };
  const other = { ...first, id: "other", data: "untouched" };
  h.api.store.dispatch(addHistoryEvent("mods", first, 2));
  h.api.store.dispatch(addHistoryEvent("mods", other, 2));
  h.api.store.dispatch(setHistoryEvent("mods", { ...first, data: "updated" }));
  h.api.store.dispatch(markHistoryReverted("mods", first));
  expect(h.getState().persistent.history.historyStacks.mods).toEqual([
    { ...first, data: "updated", reverted: true },
    other,
  ]);
});
