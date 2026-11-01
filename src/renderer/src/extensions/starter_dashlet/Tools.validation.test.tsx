import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { act, render, screen, waitFor } from "@testing-library/react";
import PromiseBB from "bluebird";
import React from "react";
import { Provider } from "react-redux";
import { createStore } from "redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IExtensionContext } from "../../types/IExtensionContext";
import type { IStarterInfo } from "../../util/StarterInfo";

vi.mock("../../views/MainWindow", async () => {
  const { createContext } = await import("react");
  return {
    MainContext: createContext({
      api: { store: { dispatch: vi.fn() }, events: { emit: vi.fn() } },
    }),
  };
});
vi.mock("../../controls/Dashlet", () => ({
  default: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock("../../controls/DynDiv", () => ({ default: () => null }));
vi.mock("./AddToolButton", () => ({ default: () => null }));
vi.mock("./ToolEditDialog", () => ({ default: () => null }));
vi.mock("./Tool", () => ({
  default: ({ starter, validToolIds }: { starter: IStarterInfo; validToolIds: string[] }) => (
    <button data-testid={`tool-${starter.id}`} disabled={!validToolIds.includes(starter.id)}>
      {starter.name}
    </button>
  ),
}));

import init from "./index";
import Tools from "./Tools";

type Props = React.ComponentProps<typeof Tools>;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nyastra-classic-tools-"));
  for (const gameId of ["alpha", "beta"]) {
    const gamePath = path.join(root, gameId);
    await mkdir(gamePath);
    await writeFile(path.join(gamePath, "game"), `${gameId} game`);
  }
  await writeFile(path.join(root, "beta", "script"), "beta tool");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fixture(active = "beta") {
  const known = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    executable: "game",
    requiredFiles: [],
  }));
  const initial = {
    session: { gameMode: { known }, base: { toolsRunning: {} } },
    persistent: {
      profiles: { alpha: { gameId: "alpha" }, beta: { gameId: "beta" } },
      mods: {},
    },
    settings: {
      profiles: { activeProfileId: active },
      interface: {
        tools: { order: { alpha: ["script", "missing"], beta: ["script", "missing"] } },
      },
      gameMode: {
        discovered: Object.fromEntries(
          known.map(({ id }) => [
            id,
            {
              path: path.join(root, id),
              tools: Object.fromEntries(
                ["script", "missing"].map((toolId) => [
                  toolId,
                  { id: toolId, name: `${id} ${toolId}`, path: path.join(root, id, toolId) },
                ]),
              ),
            },
          ]),
        ),
      },
    },
  };
  const store = createStore(
    (
      state: typeof initial = initial,
      action: { type: string; gameId?: string; toolPath?: string },
    ) => {
      if (action.type === "select") {
        return {
          ...state,
          settings: {
            ...state.settings,
            profiles: { activeProfileId: action.gameId! },
          },
        };
      }
      if (action.type === "rediscover") {
        const discovered = state.settings.gameMode.discovered;
        const beta = discovered.beta!;
        return {
          ...state,
          settings: {
            ...state.settings,
            gameMode: {
              discovered: {
                ...discovered,
                beta: {
                  ...beta,
                  tools: {
                    ...beta.tools,
                    script: { ...beta.tools.script!, path: action.toolPath! },
                  },
                },
              },
            },
          },
        };
      }
      return state;
    },
  );
  const registerDashlet = vi.fn<IExtensionContext["registerDashlet"]>();
  init({
    api: { getState: store.getState },
    registerReducer: vi.fn(),
    registerDashlet,
    registerTest: vi.fn(),
    once: vi.fn(),
  } as unknown as IExtensionContext);
  const validate = registerDashlet.mock.calls[0]![6]().onGetValidTools as Props["onGetValidTools"];
  const mount = (onGetValidTools = validate) =>
    render(
      <Provider store={store}>
        <Tools
          onGetValidTools={onGetValidTools}
          onAddDiscoveredTool={vi.fn()}
          onSetToolVisible={vi.fn()}
          onShowError={vi.fn()}
          onShowDialog={vi.fn()}
          onSetPrimary={vi.fn()}
          onSetToolOrder={vi.fn()}
        />
      </Provider>,
    );
  return { store, validate, mount };
}

describe("classic Tools validation", () => {
  it("enables an existing tool with a saved order and keeps a missing tool unavailable", async () => {
    const f = fixture();
    f.mount();

    await waitFor(() => expect(screen.getByTestId("tool-script")).toBeEnabled());
    expect(screen.getByTestId("tool-missing")).toBeDisabled();
  });

  it("validates newly discovered paths rather than the previous tool list", async () => {
    const f = fixture();
    let hold = false;
    const release = PromiseBB.defer<void>();
    const started = PromiseBB.defer<void>();
    const pending: PromiseBB<string[]>[] = [];
    const validate: Props["onGetValidTools"] = (starters, gameId) => {
      const result = f.validate(starters, gameId).then((valid) => {
        if (!hold) return valid;
        started.resolve();
        return release.promise.then(() => valid);
      });
      pending.push(result);
      return result;
    };
    const view = f.mount(validate);
    try {
      await waitFor(() => expect(screen.getByTestId("tool-script")).toBeEnabled());
      hold = true;
      act(() =>
        f.store.dispatch({ type: "rediscover", toolPath: path.join(root, "not-installed") }),
      );
      await started.promise.timeout(1000);
      expect(screen.getByTestId("tool-script")).toBeDisabled();
      await act(async () => {
        release.resolve();
        await Promise.allSettled(pending);
      });
      expect(screen.getByTestId("tool-script")).toBeDisabled();
      expect(screen.getByTestId("tool-missing")).toBeDisabled();
    } finally {
      view.unmount();
      release.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("retains the current game's result when an older validation completes later", async () => {
    const f = fixture("alpha");
    const release = PromiseBB.defer<void>();
    const started = PromiseBB.defer<void>();
    const pending: PromiseBB<string[]>[] = [];
    const validate: Props["onGetValidTools"] = (starters, gameId) => {
      const result = f.validate(starters, gameId).then((valid) => {
        if (gameId !== "alpha") return valid;
        started.resolve();
        return release.promise.then(() => valid);
      });
      pending.push(result);
      return result;
    };
    const view = f.mount(validate);
    try {
      await started.promise.timeout(1000);
      act(() => f.store.dispatch({ type: "select", gameId: "beta" }));
      await waitFor(() => expect(screen.getByTestId("tool-script")).toBeEnabled());

      await act(async () => {
        release.resolve();
        await Promise.allSettled(pending);
      });

      expect(screen.getByTestId("tool-script")).toBeEnabled();
      expect(screen.getByTestId("tool-missing")).toBeDisabled();
    } finally {
      view.unmount();
      release.resolve();
      await Promise.allSettled(pending);
    }
  });
});
