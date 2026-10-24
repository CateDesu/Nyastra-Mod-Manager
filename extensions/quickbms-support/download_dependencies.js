const fs = require("fs");
const path = require("path");
const sevenzip = require("node-7z");
const fetch = require("cross-fetch");

const QUICK_BMS_URL = "https://aluigi.altervista.org/papers/quickbms.zip";

async function downloadDependencies() {
  try {
    await fs.promises.stat("dependencies");
    console.log("dependencies already installed");
    return;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const response = await fetch(QUICK_BMS_URL, { redirect: "error" });
  if (!response.ok) {
    console.warn(`QuickBMS binary unavailable: HTTP ${response.status}. Extraction was skipped.`);
    return;
  }

  const archive = path.basename(QUICK_BMS_URL);
  try {
    await fs.promises.writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await new sevenzip().extract(archive, "dist", {
      raw: ["quickbms_4gb_files.exe"],
    });
  } finally {
    await fs.promises.rm(archive, { force: true });
  }
}

downloadDependencies().catch((err) => {
  console.error("QuickBMS dependencies failed", err);
  process.exitCode = 1;
});
