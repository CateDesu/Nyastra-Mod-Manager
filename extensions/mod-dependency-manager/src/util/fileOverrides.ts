import type { types } from "@nexusmods/vortex-api";

import type { IConflict } from "../types/IConflict";
import { topologicalSort } from "./topologicalSort";

export type FileOverridesByMod = Record<string, string[]>;

export function planOverrideUpdate(
  mods: Record<string, types.IMod>,
  enabledIds: ReadonlySet<string>,
  conflicts: Record<string, IConflict[]>,
  edits: FileOverridesByMod = {},
  priority?: string[],
): { changes: FileOverridesByMod; purgeFirst: boolean } {
  const enabled = Object.values(mods).filter((mod) => enabledIds.has(mod.id));
  const overrides = new Map(
    enabled.map((mod) => [mod.id, new Set(edits[mod.id] ?? mod.fileOverrides ?? [])]),
  );
  const sharing = new Map<string, Set<string>>();
  for (const mod of enabled) {
    for (const conflict of conflicts[mod.id] ?? []) {
      const otherId = conflict.otherMod.id;
      if (otherId === mod.id || !overrides.has(otherId)) continue;
      for (const file of conflict.files) {
        const owners = sharing.get(file) ?? new Set<string>();
        owners.add(mod.id);
        owners.add(otherId);
        sharing.set(file, owners);
      }
    }
  }

  for (const [modId, files] of overrides) {
    for (const file of files) {
      if (!sharing.get(file)?.has(modId)) files.delete(file);
    }
  }

  const order = priority ?? topologicalSort(enabled);
  for (const [file, owners] of sharing) {
    const ids = [...owners];
    const crossType = new Set(ids.map((id) => mods[id].type)).size > 1;
    if (!crossType && !ids.some((id) => overrides.get(id)!.has(file))) continue;
    const deployers = ids.filter((id) => !overrides.get(id)!.has(file));
    const winner = deployers.length === 1 ? deployers[0] : order.find((id) => owners.has(id));
    for (const id of ids) {
      if (id === winner) overrides.get(id)!.delete(file);
      else overrides.get(id)!.add(file);
    }
  }

  const changes: FileOverridesByMod = {};
  const candidates = { ...edits, ...Object.fromEntries(overrides) };
  for (const [modId, files] of Object.entries(candidates)) {
    if (mods[modId] === undefined) continue;
    const next = new Set(files);
    const previous = new Set(mods[modId].fileOverrides ?? []);
    if (next.size !== previous.size || [...next].some((file) => !previous.has(file))) {
      changes[modId] = [...next];
    }
  }

  const purgeFirst = Object.keys(changes).some((modId) => {
    const removedOrphan = (mods[modId].fileOverrides ?? []).some(
      (file) => !changes[modId].includes(file) && !sharing.get(file)?.has(modId),
    );
    return (
      removedOrphan ||
      (conflicts[modId] ?? []).some((conflict) => {
        const other = mods[conflict.otherMod.id];
        return other !== undefined && other.type !== mods[modId].type;
      })
    );
  });
  return { changes, purgeFirst };
}
