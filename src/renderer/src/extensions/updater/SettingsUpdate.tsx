import { REPOSITORY_URL } from "@vortex/shared";
import * as React from "react";

import { getApplication } from "../../util/application";

export default function SettingsUpdate(): React.JSX.Element {
  return (
    <div>
      <h3>Linux updates</h3>
      <p>Installed version: {getApplication().version}</p>
      <p>Download a Linux release and run its installer to update this program.</p>
      <button type="button" onClick={() => window.api.shell.openUrl(`${REPOSITORY_URL}/releases`)}>
        Open Nyastra releases
      </button>
    </div>
  );
}
