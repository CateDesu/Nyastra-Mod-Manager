import type { IReducerSpec } from "../../types/IExtensionContext";
import { addReducer } from "../../types/IExtensionContext";
import { setSafe } from "../../util/storeHelper";
import * as actions from "./actions";
import type { IHistoryEvent } from "./types";

export interface IHistoryPersistent {
  historyStacks: { [key: string]: IHistoryEvent[] };
}

const persistentReducer: IReducerSpec<IHistoryPersistent> = {
  reducers: {
    ...addReducer(actions.addHistoryEvent, (state, payload) => {
      const events = [...(state.historyStacks[payload.stack] ?? []), payload.event];
      return {
        ...state,
        historyStacks: {
          ...state.historyStacks,
          [payload.stack]: payload.limit > 0 ? events.slice(-payload.limit) : [],
        },
      };
    }),
    ...addReducer(actions.setHistoryEvent, (state, payload) => {
      const events = state.historyStacks[payload.stack];
      const idx = events?.findIndex((evt) => evt.id === payload.event.id) ?? -1;
      if (idx === -1) return state;
      return {
        ...state,
        historyStacks: {
          ...state.historyStacks,
          [payload.stack]: events.map((evt, index) => (index === idx ? payload.event : evt)),
        },
      };
    }),
    ...addReducer(actions.markHistoryReverted, (state, payload) => {
      const events = state.historyStacks[payload.stack];
      const idx = events?.findIndex((evt) => evt.id === payload.event.id) ?? -1;
      if (idx === -1) return state;
      return {
        ...state,
        historyStacks: {
          ...state.historyStacks,
          [payload.stack]: events.map((evt, index) =>
            index === idx ? { ...evt, reverted: true } : evt,
          ),
        },
      };
    }),
  },
  defaults: {
    historyStacks: {},
  },
};

export interface IHistoryState {
  stackToShow: string;
}

const sessionReducer: IReducerSpec<IHistoryState> = {
  reducers: {
    ...addReducer(actions.showHistory, (state, payload) =>
      setSafe(state, ["stackToShow"], payload),
    ),
  },
  defaults: {
    stackToShow: undefined,
  },
};

export { persistentReducer, sessionReducer };
