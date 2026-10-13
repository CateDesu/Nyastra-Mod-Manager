/**
 * Backward-compatible shim for historical imports.
 *
 * SMAPI installer logic now lives in `installers/smapi/`.
 */
export {
  installSMAPI,
  isSMAPIModType,
  linuxSMAPIPlatform,
  resolveSMAPIPlatform,
  SMAPI_EXE,
  testSMAPI,
} from "./smapi";
export type { ISMAPIPlatformVariant } from "./smapi";
