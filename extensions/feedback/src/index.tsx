import { mdiCommentTextOutline } from "@mdi/js";
import { types, util } from "@nexusmods/vortex-api";

import { sessionReducer } from "./reducers/session";
import FeedbackView from "./views/FeedbackView";

const ISSUE_TRACKER = "https://github.com/CateDesu/Nyastra-Mod-Manager/issues";

function init(context: types.IExtensionContext): boolean {
  context.registerReducer(["session", "feedback"], sessionReducer);
  context.registerMainPage("", "Feedback", FeedbackView, {
    hotkey: "F",
    group: "hidden",
    props: () => ({}),
    mdi: mdiCommentTextOutline,
  } as any);
  for (const [icon, title] of [
    ["feedback", "Send Feedback"],
    ["bug", "Report Bug"],
  ]) {
    context.registerAction(
      "global-icons",
      100,
      icon,
      { classicOnly: true } as any,
      title,
      () => util.opn(ISSUE_TRACKER).catch(() => null) as any,
    );
  }
  context.once(() => {
    const notify = () =>
      context.api.sendNotification({
        id: "report-feedback",
        type: "info",
        message: "Please report this on our issue tracker. Logs are not uploaded automatically.",
        actions: [
          {
            title: "Open issue tracker",
            action: () => {
              void util.opn(ISSUE_TRACKER).catch(() => null);
            },
          },
        ],
      });
    context.api.events.on("report-feedback", notify);
    context.api.events.on("report-log-error", notify);
  });
  return true;
}

export default init;
