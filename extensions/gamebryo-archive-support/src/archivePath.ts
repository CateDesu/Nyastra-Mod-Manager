import * as path from "path";

export function archiveOutputPath(outputPath: string, name: string): string {
  const root = path.resolve(outputPath);
  const target = path.resolve(root, name.replace(/\\/g, path.sep));
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Archive entry is outside the extraction directory");
  }
  return target;
}
