import type { IExtensionApi } from "../../../types/IExtensionContext";

export function startDownloadFromURL(api: IExtensionApi, url: string, install?: boolean): void {
  api.events.emit(
    "start-download",
    [url],
    {},
    undefined,
    (err, downloadId) => {
      if (install && err === null && downloadId !== undefined) {
        api.events.emit("start-install-download", downloadId);
      }
    },
    undefined,
    // The callback owns explicit installation, so completion must not also auto-install.
    install ? { allowInstall: false } : undefined,
  );
}
