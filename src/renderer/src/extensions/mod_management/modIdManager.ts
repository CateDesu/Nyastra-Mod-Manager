export function deriveModInstallName(archiveName: string, _info?: unknown): string {
  return archiveName.replace(/[\/\0]/g, (value) => `_${value.charCodeAt(0)}_`);
}

export default deriveModInstallName;
