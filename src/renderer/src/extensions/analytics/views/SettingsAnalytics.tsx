import { SUPPORT_URL } from "@vortex/shared";
import * as React from "react";
import { ControlLabel, FormGroup, HelpBlock } from "react-bootstrap";

import { ComponentEx, translate } from "../../../controls/ComponentEx";
import { TypographyLink } from "../../../ui/components/typography/TypographyLink";
import opn from "../../../util/opn";

class SettingsAnalytics extends ComponentEx<{}, {}> {
  public render(): JSX.Element {
    const { t } = this.props;
    return (
      <form>
        <FormGroup controlId="analytics">
          <ControlLabel>{t("Data & Privacy")}</ControlLabel>
          <HelpBlock>
            {t(
              "This preview does not upload usage data or crash reports. Support reports are submitted manually on our issue tracker.",
            )}
          </HelpBlock>
          <TypographyLink
            brand="info"
            onClick={() => {
              void opn(SUPPORT_URL).catch(() => undefined);
            }}
          >
            {t("Open issue tracker")}
          </TypographyLink>
        </FormGroup>
      </form>
    );
  }
}

export default translate(["common"])(SettingsAnalytics) as React.ComponentClass<{}>;
