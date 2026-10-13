import { ComponentEx, MainPage, util } from "@nexusmods/vortex-api";
import * as React from "react";
import { Button } from "react-bootstrap";
import { withTranslation } from "react-i18next";

const ISSUE_TRACKER = "https://github.com/CateDesu/Nyastra-Mod-Manager/issues";

class FeedbackView extends ComponentEx<{}, {}> {
  public render(): JSX.Element {
    const { t } = this.props;
    return (
      <MainPage id="page-feedback">
        <MainPage.Body>
          <h2>{t("Support and feedback")}</h2>
          <p>
            {t(
              "Report bugs, ask questions and suggest improvements on the Nyastra's Mod Manager issue tracker.",
            )}
          </p>
          <p>
            {t(
              "Include your program version, Linux distribution and steps to reproduce the problem. Review logs before attaching them. Nothing is uploaded automatically.",
            )}
          </p>
          <Button
            onClick={() => {
              void util.opn(ISSUE_TRACKER).catch(() => null);
            }}
          >
            {t("Open issue tracker")}
          </Button>
        </MainPage.Body>
      </MainPage>
    );
  }
}

export default withTranslation(["common"])(FeedbackView);
