/**
 * User-facing SMAPI provisioning workflow.
 */
import type { types } from "@nexusmods/vortex-api";
import { selectors, util } from "@nexusmods/vortex-api";

import { GAME_ID, SMAPI_URL } from "../common";
import { downloadSMAPI } from "./download";
import { installDownloadedSMAPI, enableSMAPIMod } from "./install";
import { deploySMAPI } from "./lifecycle";

/**
 * Downloads, installs, enables, and deploys SMAPI from Nexus.
 *
 * @param api Vortex extension API (`types.IExtensionApi`) used for
 * notifications, installation events, and deployment.
 * @param update Optional update flag (`boolean`). When true, user messaging is
 * rendered as an update flow.
 * @returns Resolves after provisioning and deployment complete.
 */
export async function downloadAndInstallSMAPI(
  api: types.IExtensionApi,
  update?: boolean,
): Promise<void> {
  const profileId = selectors.lastActiveProfileForGame(api.getState(), GAME_ID);
  if (profileId === undefined) return;
  const isCurrent = () => selectors.lastActiveProfileForGame(api.getState(), GAME_ID) === profileId;
  api.dismissNotification?.("smapi-missing");
  api.sendNotification?.({
    id: "smapi-installing",
    message: update ? "Updating SMAPI" : "Installing SMAPI",
    type: "activity",
    noDismiss: true,
    allowSuppress: false,
  });

  try {
    const downloadId = await downloadSMAPI(api);
    if (!isCurrent()) return;
    const modId = await installDownloadedSMAPI(api, downloadId, profileId);
    if (!isCurrent()) return;
    await enableSMAPIMod(api, modId, profileId);
    if (!isCurrent()) return;

    await deploySMAPI(api, profileId);
  } catch (err) {
    if (err instanceof util.UserCanceled) return;
    api.showErrorNotification?.("Failed to download/install SMAPI", err);
    util.opn(SMAPI_URL).catch(() => null);
  } finally {
    api.dismissNotification?.("smapi-installing");
  }
}
