import * as nodeFs from "node:fs";
import * as path from "node:path";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as PropTypes from "prop-types";
import * as React from "react";
import { Provider } from "react-redux";
import { afterEach, expect, vi } from "vitest";

import { makeApiHarness, makeProfile } from "../../../test-utils/builders";
import { test } from "../../../test-utils/deploymentTest";
import type { ITableAttribute } from "../../../types/ITableAttribute";
import { confirmExternalChanges } from "../actions/session";
import { sessionReducer } from "../reducers/session";
import { dealWithExternalChanges } from "../util/externalChanges";
import ExternalChangeDialog from "./ExternalChangeDialog";

// Keep the dialog's grouping, handlers, connection and reducer real.
vi.mock("../../../controls/Table", () => ({
  default: ({ tableId, data, staticElements }) => {
    const action = (staticElements as ITableAttribute[]).find((column) => column.id === "action");
    const name = (staticElements as ITableAttribute[]).find((column) => column.id === "name");
    return (
      <div data-testid={tableId}>
        {data.map((entry, index) => (
          <select
            key={index}
            data-testid={`${tableId}-${index}`}
            data-row-id={entry.id}
            data-name={name.calc(entry, undefined)}
            data-mod-type={entry.modTypeId}
            value={entry.action}
            onChange={(event) => action.edit.onChangeValue(entry, event.target.value)}
          >
            {action.edit.choices(entry).map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.key}
              </option>
            ))}
          </select>
        ))}
      </div>
    );
  },
}));

vi.mock("../../../controls/Modal", () => {
  const Part = ({ children }) => <div>{children}</div>;
  return { default: Object.assign(Part, { Header: Part, Title: Part, Body: Part, Footer: Part }) };
});
vi.mock("../../../controls/Toggle", () => ({
  default: ({ checked, onToggle }) => (
    <input type="checkbox" checked={checked} onChange={onToggle} />
  ),
}));
vi.mock("../../../controls/TooltipControls", () => ({
  Button: ({ id, onClick, children }) => (
    <button id={id} onClick={onClick}>
      {children}
    </button>
  ),
}));

afterEach(cleanup);

async function bounded<T>(operation: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("External change confirmation timed out")), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function replace(file: string, content: string) {
  nodeFs.unlinkSync(file);
  nodeFs.writeFileSync(file, content);
  const newer = new Date(Date.now() + 10_000);
  nodeFs.utimesSync(file, newer, newer);
}

function makeSession() {
  return makeApiHarness({ profiles: { p: makeProfile({ id: "p" }) }, activeProfileId: "p" }, [
    { path: ["session", "mods"], reducer: sessionReducer },
  ]);
}

class ApiContext extends React.Component<
  React.PropsWithChildren<{ api: ReturnType<typeof makeSession>["api"] }>
> {
  public static childContextTypes = { api: PropTypes.object };
  public getChildContext() {
    return { api: this.props.api };
  }
  public render() {
    return this.props.children;
  }
}

function renderDialog(session: ReturnType<typeof makeSession>) {
  return render(
    <ApiContext api={session.api}>
      <Provider store={session.api.store}>
        <ExternalChangeDialog />
      </Provider>
    </ApiContext>,
  );
}

for (const individual of [false, true]) {
  for (const otherName of ["other.ini", "config.ini"]) {
    test(`${individual ? "file" : "source"} selection preserves another mod's ${otherName} through confirmation`, async ({
      makeDeployment,
    }) => {
      const h = makeDeployment({
        files: { "config.ini": "selected staged", "extra.ini": "extra staged" },
      });
      const session = makeSession();
      const first = path.join(h.stagingDir, "SomeMod");
      const second = path.join(h.stagingDir, "OtherMod");
      nodeFs.mkdirSync(second);
      nodeFs.writeFileSync(path.join(second, otherName), "other staged");
      await h.method.prepare(h.gameDir, true, [], h.normalize);
      await h.method.activate(first, "SomeMod", "Selected", new Set());
      await h.method.activate(second, "OtherMod", "Other", new Set());
      const manifest = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
      replace(h.inGame("Selected/config.ini"), "selected external");
      replace(h.inGame("Selected/extra.ini"), "extra external");
      replace(h.inGame(`Other/${otherName}`), "other external");
      const last = { "": manifest };
      const outcome = dealWithExternalChanges(
        session.api,
        h.method,
        "p",
        h.stagingDir,
        { "": h.gameDir },
        last,
      ).then(
        () => undefined,
        (err: unknown) => err,
      );
      try {
        await vi.waitFor(() => expect(session.getState().session.mods.changes).toHaveLength(3), {
          timeout: 1000,
        });
        const view = renderDialog(session);
        if (individual) fireEvent.click(screen.getByRole("checkbox"));
        const choices = session.getState().session.mods.changes;
        const index = choices.findIndex(
          (entry) => entry.source === "SomeMod" && entry.filePath === "config.ini",
        );
        const row = individual
          ? screen.getByTestId(`external-change-refchange-${index}`)
          : screen
              .getAllByRole("combobox")
              .find((row) => row.getAttribute("data-name") === "SomeMod");
        fireEvent.change(row, { target: { value: "drop" } });
        const selected = session.getState().session.mods.changes;
        expect.soft(selected.find((entry) => entry.source === "OtherMod").action).toBe("newest");
        expect
          .soft(selected.find((entry) => entry.filePath === "extra.ini").action)
          .toBe(individual ? "newest" : "drop");
        fireEvent.click(view.container.querySelector("#btn-confirm-activation"));
        expect(await bounded(outcome)).toBeUndefined();
        expect
          .soft(nodeFs.readFileSync(path.join(first, "config.ini"), "utf8"))
          .toBe("selected staged");
        expect
          .soft(nodeFs.readFileSync(path.join(first, "extra.ini"), "utf8"))
          .toBe(individual ? "extra external" : "extra staged");
        expect
          .soft(nodeFs.readFileSync(path.join(second, otherName), "utf8"))
          .toBe("other external");
        expect(nodeFs.existsSync(h.inGame("Selected/config.ini"))).toBe(false);
        expect(nodeFs.existsSync(h.inGame(`Other/${otherName}`))).toBe(false);
        expect(last[""]).toEqual([]);
      } finally {
        act(() => {
          session.api.store.dispatch(confirmExternalChanges([], true));
        });
        await bounded(outcome);
      }
    });
  }

  test(`${individual ? "file" : "source"} selection separates the same source and path across mod types`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ files: { "config.ini": "shared staged" } });
    const session = makeSession();
    const source = path.join(h.stagingDir, "SomeMod");
    const secondary = h.inGame("Secondary");
    nodeFs.mkdirSync(secondary);
    await h.method.prepare(h.gameDir, true, [], h.normalize);
    await h.method.activate(source, "SomeMod", "", new Set());
    const primaryManifest = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
    await h.method.prepare(secondary, true, [], h.normalize);
    await h.method.activate(source, "SomeMod", "", new Set());
    const secondaryManifest = await h.method.finalize("skyrimse", secondary, h.stagingDir);
    replace(h.inGame("config.ini"), "primary external");
    replace(path.join(secondary, "config.ini"), "secondary external");
    const last = { "": primaryManifest, secondary: secondaryManifest };
    const outcome = dealWithExternalChanges(
      session.api,
      h.method,
      "p",
      h.stagingDir,
      { "": h.gameDir, secondary },
      last,
    ).then(
      () => undefined,
      (err: unknown) => err,
    );
    try {
      await vi.waitFor(() => expect(session.getState().session.mods.changes).toHaveLength(2), {
        timeout: 1000,
      });
      const view = renderDialog(session);
      if (individual) fireEvent.click(screen.getByRole("checkbox"));
      const rows = screen.getAllByRole("combobox");
      expect.soft(rows).toHaveLength(2);
      if (!individual)
        expect.soft(new Set(rows.map((row) => row.getAttribute("data-row-id"))).size).toBe(2);
      fireEvent.change(
        rows.find((row) => row.getAttribute("data-mod-type") === ""),
        { target: { value: "drop" } },
      );
      const selected = session.getState().session.mods.changes;
      expect.soft(selected.find((entry) => entry.modTypeId === "").action).toBe("drop");
      expect.soft(selected.find((entry) => entry.modTypeId === "secondary").action).toBe("newest");
      fireEvent.click(view.container.querySelector("#btn-confirm-activation"));
      expect(await bounded(outcome)).toBeUndefined();
      expect
        .soft(nodeFs.readFileSync(path.join(source, "config.ini"), "utf8"))
        .toBe("secondary external");
      expect(nodeFs.existsSync(h.inGame("config.ini"))).toBe(false);
      expect(nodeFs.existsSync(path.join(secondary, "config.ini"))).toBe(false);
      expect(last).toEqual({ "": [], secondary: [] });
    } finally {
      act(() => {
        session.api.store.dispatch(confirmExternalChanges([], true));
      });
      await bounded(outcome);
    }
  });

  test(`set-all in ${individual ? "file" : "source"} view preserves the same-named deleted group`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ files: { "config.ini": "selected staged" } });
    const session = makeSession();
    const other = path.join(h.stagingDir, "OtherMod");
    const third = path.join(h.stagingDir, "ThirdMod");
    nodeFs.mkdirSync(other);
    nodeFs.mkdirSync(third);
    nodeFs.writeFileSync(path.join(other, "config.ini"), "deleted staged");
    nodeFs.writeFileSync(path.join(third, "config.ini"), "third staged");
    await h.method.prepare(h.gameDir, true, [], h.normalize);
    await h.method.activate(path.join(h.stagingDir, "SomeMod"), "SomeMod", "Selected", new Set());
    await h.method.activate(other, "OtherMod", "Other", new Set());
    await h.method.activate(third, "ThirdMod", "Third", new Set());
    const manifest = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
    replace(h.inGame("Selected/config.ini"), "selected external");
    replace(h.inGame("Third/config.ini"), "third external");
    nodeFs.unlinkSync(h.inGame("Other/config.ini"));
    const last = { "": manifest };
    const outcome = dealWithExternalChanges(
      session.api,
      h.method,
      "p",
      h.stagingDir,
      { "": h.gameDir },
      last,
    ).then(
      () => undefined,
      (err: unknown) => err,
    );
    try {
      await vi.waitFor(() => expect(session.getState().session.mods.changes).toHaveLength(3), {
        timeout: 1000,
      });
      const view = renderDialog(session);
      if (individual) fireEvent.click(screen.getByRole("checkbox"));
      const deleted = session
        .getState()
        .session.mods.changes.find((entry) => entry.type === "deleted");
      expect(deleted.action).toBe("delete");
      const revertAll = screen
        .getAllByRole("link")
        .find((link) => link.getAttribute("href") === "#drop");
      fireEvent.click(revertAll);
      expect(
        session
          .getState()
          .session.mods.changes.filter((entry) => entry.type === "refchange")
          .map((entry) => entry.action),
      ).toEqual(["drop", "drop"]);
      expect
        .soft(
          session.getState().session.mods.changes.find((entry) => entry.type === "deleted").action,
        )
        .toBe("delete");
      fireEvent.click(view.container.querySelector("#btn-confirm-activation"));
      expect(await bounded(outcome)).toBeUndefined();
      expect.soft(nodeFs.existsSync(path.join(other, "config.ini"))).toBe(false);
      expect(nodeFs.readFileSync(path.join(third, "config.ini"), "utf8")).toBe("third staged");
      expect(last[""]).toEqual([]);
    } finally {
      act(() => {
        session.api.store.dispatch(confirmExternalChanges([], true));
      });
      await bounded(outcome);
    }
  });
}
