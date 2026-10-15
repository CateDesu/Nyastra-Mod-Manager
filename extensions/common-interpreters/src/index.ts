import * as path from "path";
import * as process from "process";

import { log, types, util } from "@nexusmods/vortex-api";
import * as which from "which";

function exeExtension(): string {
  return "";
}

function findJava(): string {
  if (process.env.JAVA_HOME === undefined) {
    return undefined;
  }
  const fileName = "java" + exeExtension();
  // TODO: A bit too simplistic, check the registry on windows
  return path.join(process.env.JAVA_HOME, "bin", fileName);
}

function findPython(): string {
  for (const name of ["python3", "python"]) {
    try {
      return which.sync(name);
    } catch {
      // Try the next available interpreter name.
    }
  }
  log("info", "python not found");
  return undefined;
}

const javaPath: string = findJava();
const pythonPath: string = findPython();

function init(context: types.IExtensionContext): boolean {
  context.registerInterpreter(".jar", (input: types.IRunParameters) => {
    if (javaPath === undefined) {
      throw new (util as any).MissingInterpreter(
        "Java isn't installed",
        "https://www.java.com/de/download/",
      );
    }
    return {
      executable: javaPath,
      args: ["-jar", input.executable].concat(input.args),
      options: input.options,
    };
  });

  context.registerInterpreter(".py", (input: types.IRunParameters) => {
    if (pythonPath === undefined) {
      throw new (util as any).MissingInterpreter(
        "Python isn't installed",
        "https://www.python.org/downloads/",
      );
    }
    return {
      executable: pythonPath,
      args: [input.executable].concat(input.args),
      options: input.options,
    };
  });

  return true;
}

export default init;
