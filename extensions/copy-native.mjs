#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node copy-native.mjs <file1> <file2> ...");
  process.exit(1);
}

const files = args.filter((arg) => !arg.startsWith("-") && !/^\d+$/.test(arg));
const copyFlags = args.filter((arg) => arg.startsWith("-") || /^\d+$/.test(arg));
if (copyFlags.length === 0) copyFlags.push("-u", "1", "-f");

const missingFiles = [];

for (const file of files) {
  if (!fs.existsSync(file)) {
    missingFiles.push(file);
  }
}

if (missingFiles.length > 0) {
  console.error("Missing native files:");
  for (const file of missingFiles) {
    console.error(`  - ${file}`);
  }
  process.exit(1);
}

const destDir = "dist";
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

try {
  execFileSync("copyfiles", [...copyFlags, ...files, destDir], { stdio: "inherit" });
} catch (err) {
  console.error("Failed to copy native files");
  process.exit(1);
}
