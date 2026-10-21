// Main process webview utilities

import type { WebContentsView, BrowserWindow } from "electron";

/**
 * Tracks WebContentsViews by webContents ID
 * Structure: { [contentsId]: { [viewId]: WebContentsView } }
 */
export const extraWebViews: {
  [contentsId: number]: { [viewId: string]: WebContentsView };
} = {};

export function registerView(
  window: BrowserWindow,
  view: WebContentsView,
  cleanup: () => void = () => {},
): string {
  const ownerContents = window.webContents;
  const contentsId = ownerContents.id;
  const viewId = `${contentsId}_${view.webContents.id}`;
  extraWebViews[contentsId] ??= {};
  extraWebViews[contentsId][viewId] = view;
  const close = () => closeView(contentsId, viewId, window);
  ownerContents.once("destroyed", close);
  view.webContents.once("destroyed", () => {
    cleanup();
    ownerContents.off("destroyed", close);
    delete extraWebViews[contentsId]?.[viewId];
    if (Object.keys(extraWebViews[contentsId] ?? {}).length === 0) {
      delete extraWebViews[contentsId];
    }
  });
  return viewId;
}

export function closeView(contentsId: number, viewId: string, window?: BrowserWindow): void {
  const view = extraWebViews[contentsId]?.[viewId];
  if (view === undefined) return;
  delete extraWebViews[contentsId]?.[viewId];
  try {
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
  } catch {
    // The owner may have already detached the view.
  }
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

/**
 * Closes all WebContentsViews associated with a window
 */
export function closeAllViews(window: BrowserWindow) {
  const contentsId = window.webContents.id;
  for (const viewId of Object.keys(extraWebViews[contentsId] ?? {})) {
    closeView(contentsId, viewId, window);
  }
}
