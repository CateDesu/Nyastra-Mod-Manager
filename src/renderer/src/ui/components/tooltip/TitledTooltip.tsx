import React from "react";

/**
 * A tooltip's bold title over what it means, as the design words these: 240px wide. For a
 * `Tooltip`'s `customContent`, with the tooltip's own padding and type.
 */
export const TitledTooltip = ({ title, body }: { title: string; body: string }) => (
  <div className="nxm-tooltip-content max-w-60">
    <p className="font-semibold">{title}</p>

    <p>{body}</p>
  </div>
);
