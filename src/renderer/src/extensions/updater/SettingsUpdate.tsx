import { formatProgramVersion, REPOSITORY_URL } from "@vortex/shared";
import React from "react";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";

import { useMainContext } from "@/contexts";
import type { IState } from "@/types/IState";
import { Button } from "@/ui/components/button/Button";
import { CheckboxField } from "@/ui/components/form/checkbox_field/CheckboxField";

import { getApplication } from "../../util/application";
import { setUpdateChannel } from "./actions";
import { checkForUpdates } from "./checkForUpdates";

const selectCheck = (state: IState) => state.session.updater?.check;
const selectChecking = (state: IState) => state.session.updater?.checking ?? false;
const selectAutomatic = (state: IState) => state.settings.update?.channel !== "none";

export default function SettingsUpdate(): React.JSX.Element {
  const { t } = useTranslation();
  const { api } = useMainContext();
  const result = useSelector(selectCheck);
  const checking = useSelector(selectChecking);
  const automatic = useSelector(selectAutomatic);
  let message = t("Updates have not been checked yet.");
  if (checking) message = t("Checking for updates…");
  else if (result?.status === "available")
    message = t("An update is available: {{version}}", {
      replace: { version: result.kind === "source" ? result.latest?.slice(0, 10) : result.latest },
    });
  else if (result?.status === "current") message = t("No newer updates were found.");
  else if (result?.status === "error")
    message = t("Could not check for updates. Check your connection and try again.");
  else if (result?.reason === "no-release")
    message = t("No compatible Linux release has been published yet.");
  else if (result?.reason === "not-main")
    message = t("This source checkout is not on main. See the update instructions.");
  else if (result?.reason === "local-history")
    message = t("This checkout has local or different history. Review it before updating.");
  return (
    <div className="flex flex-col gap-4">
      <h3>{t("Linux updates")}</h3>
      <p>
        {t("Installed version: {{version}}", {
          replace: { version: `v${formatProgramVersion(getApplication().version)}` },
        })}
      </p>
      <CheckboxField
        checked={automatic}
        label={t("Automatically check for updates")}
        onChange={(enabled) => {
          api.store.dispatch(setUpdateChannel(enabled ? "stable" : "none"));
          if (enabled) void checkForUpdates(api);
        }}
      />
      <p>
        {t("Checks run after startup and every six hours. Updates are installed when you choose.")}
      </p>
      <p aria-live="polite" role="status">
        {message}
      </p>
      {result?.dirty && <p>{t("This checkout has local changes. Save them before updating.")}</p>}
      {result?.kind === "source" ? (
        <p>
          {t(
            "Source updates come from Nyastra's main branch. Pull the changes and rebuild using the update instructions.",
          )}
        </p>
      ) : (
        <p>
          {t(
            "Close the program and install the new Linux package to update. Your settings are kept.",
          )}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          data-testid="check-updates"
          disabled={checking}
          onClick={() => {
            void checkForUpdates(api);
          }}
        >
          {t("Check now")}
        </Button>
        <Button
          appearance="weak"
          data-testid="open-update"
          onClick={() => window.api.shell.openUrl(result?.url ?? `${REPOSITORY_URL}/releases`)}
        >
          {result?.kind === "source" ? t("Update instructions") : t("Open Nyastra releases")}
        </Button>
      </div>
    </div>
  );
}
