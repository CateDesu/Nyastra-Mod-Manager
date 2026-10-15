import { mdiChevronDown, mdiPower } from "@mdi/js";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";

import { useMainContext } from "@/contexts";
import type { IState } from "@/types/IState";
import { Dropdown } from "@/ui/components/dropdown/Dropdown";
import { DropdownButton } from "@/ui/components/dropdown/DropdownButton";
import { DropdownItem } from "@/ui/components/dropdown/DropdownItem";
import { DropdownItems } from "@/ui/components/dropdown/DropdownItems";

import { activeProfile } from "../../../profile_management/selectors";
import {
  changeProfileMods,
  modEnableControlsBlocked,
  type ProfileModChange,
} from "../../util/changeProfileMods";

const selectMods = (state: IState) => {
  const profile = activeProfile(state);
  return profile === undefined ? undefined : state.persistent.mods[profile.gameId];
};

export const ModEnableControls = () => {
  const { t } = useTranslation();
  const { api } = useMainContext();
  const profile = useSelector(activeProfile);
  const mods = useSelector(selectMods);
  const blocked = useSelector(modEnableControlsBlocked);
  const [busy, setBusy] = useState(false);
  const installed = Object.keys(mods ?? {}).filter((id) => mods[id].state === "installed");
  const hasEnabled = installed.some((id) => profile?.modState?.[id]?.enabled === true);
  const hasDisabled = installed.some((id) => profile?.modState?.[id]?.enabled !== true);

  const change = (operation: ProfileModChange) => {
    if (busy || blocked || profile === undefined) {
      return;
    }
    setBusy(true);
    void changeProfileMods(api, profile.id, operation)
      .catch((err) => api.showErrorNotification("Failed to enable/disable mods", err))
      .finally(() => setBusy(false));
  };

  return (
    <Dropdown className="shrink-0">
      <DropdownButton
        appearance="weak"
        data-testid="mod-enable-controls"
        disabled={busy || blocked}
        leftIconPath={mdiPower}
        rightIconPath={mdiChevronDown}
      >
        {t("Mods on/off")}
      </DropdownButton>

      <DropdownItems>
        <DropdownItem disabled={!hasEnabled} onClick={() => change("disable")}>
          {t("Disable all mods and remember enabled")}
        </DropdownItem>

        <DropdownItem
          disabled={profile?.enabledModsBeforeDisable === undefined}
          onClick={() => change("restore")}
        >
          {t("Restore previously enabled mods")}
        </DropdownItem>

        <DropdownItem disabled={!hasDisabled} onClick={() => change("enable")}>
          {t("Enable all installed mods")}
        </DropdownItem>
      </DropdownItems>
    </Dropdown>
  );
};
