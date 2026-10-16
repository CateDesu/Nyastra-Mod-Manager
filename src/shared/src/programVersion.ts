export function formatProgramVersion(version: string): string {
  const match = /^v?2\.9\.(0|[1-9]\d*)$/.exec(version);
  if (!match || Number(match[1]) > 999) return version;
  return `1.${match[1]!.padStart(2, "0")}`;
}

export function packageVersionFromRelease(version: string): string {
  const match = /^v?1\.(\d{2,3})$/.exec(version);
  if (!match || String(Number(match[1])).padStart(2, "0") !== match[1]) return version;
  return `2.9.${Number(match[1])}`;
}
