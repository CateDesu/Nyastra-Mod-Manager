import { arch } from "node:os";

export const getCPUArch = (): string => arch();
