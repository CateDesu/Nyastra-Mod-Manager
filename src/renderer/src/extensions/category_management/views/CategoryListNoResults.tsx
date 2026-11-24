import { mdiFolderPlus, mdiUpdate } from "@mdi/js";
import type { TFunction } from "i18next";
import React from "react";

import { Button } from "@/ui/components/button/Button";
import { Typography } from "@/ui/components/typography/Typography";

interface ICustomNoCategoryResultsProps {
  fetch: () => void;
  create: () => void;
  t: TFunction;
  searchTerm?: string;
}

const CustomNoCategoryResults = ({
  fetch,
  create,
  searchTerm,
  t,
}: ICustomNoCategoryResultsProps) => {
  return (
    <div className="flex flex-col items-center gap-y-4 py-16">
      <Typography appearance="subdued" typographyType="body-md">
        {!searchTerm && t("No categories")}

        {!!searchTerm && t(`No categories matching "{{searchTerm}}"`, { searchTerm })}
      </Typography>

      <Button appearance="subdued" brand="neutral" leftIconPath={mdiFolderPlus} onClick={create}>
        {t("Create Category")}
      </Button>

      <Button appearance="subdued" brand="neutral" leftIconPath={mdiUpdate} onClick={fetch}>
        {t("Sync with Nexus Mods")}
      </Button>
    </div>
  );
};

export default CustomNoCategoryResults;
