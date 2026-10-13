import { deregisterLinuxProtocolHandler, registerLinuxProtocolHandler } from "./linux";
import type { IProtocolRegistrationOptions } from "./types";

export type { IProtocolRegistrationOptions } from "./types";

export function registerProtocolHandler(options: IProtocolRegistrationOptions): Promise<boolean> {
  return Promise.resolve(registerLinuxProtocolHandler(options));
}

export function deregisterProtocolHandler(protocol: string, _userDataPath?: string): Promise<void> {
  deregisterLinuxProtocolHandler(protocol);
  return Promise.resolve();
}
