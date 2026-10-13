import React from "react";

import { joinClasses } from "@/ui/utils/joinClasses";

export const NexusBadge = ({ className }: { className?: string }) => (
  <svg
    aria-hidden
    className={joinClasses(["size-4 shrink-0", className])}
    fill="currentColor"
    role="presentation"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <image href="assets/images/nyastra.png" width="24" height="24" />
  </svg>
);
