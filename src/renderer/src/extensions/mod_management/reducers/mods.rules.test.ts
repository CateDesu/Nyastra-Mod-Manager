import { expect } from "vitest";

import { makeMod } from "../../../test-utils/builders";
import { test } from "../../../test-utils/harnessTest";
import { addModRule } from "../actions/mods";
import type { IModRule } from "../types/IMod";

test("ordering changes preserve dependency rules for the same mod", async ({ makeApi }) => {
  const required: IModRule = { type: "requires", reference: { id: "dependency" } };
  const after: IModRule = { type: "after", reference: { id: "dependency" } };
  const before: IModRule = { type: "before", reference: { id: "dependency" } };
  const h = makeApi({ mods: { skyrimse: { owner: makeMod({ id: "owner", rules: [required] }) } } });

  h.api.store.dispatch(addModRule("skyrimse", "owner", after));
  expect(h.getState().persistent.mods.skyrimse.owner.rules).toEqual([required, after]);
  h.api.store.dispatch(addModRule("skyrimse", "owner", before));
  expect(h.getState().persistent.mods.skyrimse.owner.rules).toEqual([required, before]);
});

test("changing a required mod to recommended preserves ordering and conflict rules", async ({
  makeApi,
}) => {
  const after: IModRule = { type: "after", reference: { id: "dependency" } };
  const conflict: IModRule = { type: "conflicts", reference: { id: "dependency" } };
  const required: IModRule = { type: "requires", reference: { id: "dependency" } };
  const recommended: IModRule = { type: "recommends", reference: { id: "dependency" } };
  const h = makeApi({
    mods: { skyrimse: { owner: makeMod({ id: "owner", rules: [after, conflict, required] }) } },
  });

  h.api.store.dispatch(addModRule("skyrimse", "owner", recommended));
  expect(h.getState().persistent.mods.skyrimse.owner.rules).toEqual([after, conflict, recommended]);
});
