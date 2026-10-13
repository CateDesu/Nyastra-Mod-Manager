import { VortexError } from "@vortex/shared";
import type { IOSPathProvider } from "@vortex/shared/filesystem";

import { LinuxPathProvider } from "./paths.linux";

// oxlint-disable-next-line typescript/no-extraneous-class
export class OSPathProvider {
  static #instance: IOSPathProvider | undefined;

  static get instance(): IOSPathProvider {
    let provider = this.#instance;
    if (provider) return provider;

    provider = create();
    this.#instance ??= provider;

    return this.#instance;
  }
}

function create(): IOSPathProvider {
  if (process.platform === "linux") return new LinuxPathProvider();
  else
    throw new VortexError(`Unsupported platform: '${process.platform}'`, {
      kind: "os:unsupported",
    });
}
