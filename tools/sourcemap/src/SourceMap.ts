import * as path from "path";

import * as fs from "fs-extra";
import { SourceMapConsumer } from "source-map";

interface IPosition {
  source: string;
  line: number;
  column: number;
}

const sourceMappingRE = /^\/\/# sourceMappingURL=([a-zA-Z0-9._\-\/\\]+)$/;

class SourceMap {
  private mConsumers: { [fileName: string]: Promise<SourceMapConsumer> } = {};
  private mSourcePath: string;
  private mBasePath: string;

  constructor(sourcePath: string, basePath: string) {
    this.mSourcePath = path.resolve(sourcePath);
    this.mBasePath = basePath;
  }

  public lookup(position: IPosition): Promise<IPosition> {
    return this.getConsumer(position.source).then((consumer) =>
      consumer === null
        ? position
        : consumer.originalPositionFor({
            line: position.line,
            column: position.column,
          }),
    );
  }

  private findSourceMapPath(sourceData: string): string {
    // search for the sourceMappingURL from back to front
    const sourceMappingLine = sourceData
      .split("\n")
      .reverse()
      .find((line) => line.match(sourceMappingRE) !== null);
    return sourceMappingLine !== undefined
      ? sourceMappingLine.match(sourceMappingRE)[1]
      : undefined;
  }

  private getConsumer(file: string): Promise<SourceMapConsumer> {
    const relPath = this.mBasePath !== undefined ? path.relative(this.mBasePath, file) : file;

    if (this.mConsumers[relPath] === undefined) {
      const correctedPath = path.join(this.mSourcePath, relPath);
      this.mConsumers[relPath] = this.readSourceFile(correctedPath)
        .then((data) => {
          const sourceMapPath = this.findSourceMapPath(data.toString());
          if (sourceMapPath === undefined) {
            return Promise.reject(null);
          }
          const fullPath: string = sourceMapPath.startsWith("/")
            ? this.mSourcePath + sourceMapPath
            : path.resolve(this.mSourcePath, path.dirname(relPath), sourceMapPath);
          return this.readSourceFile(fullPath);
        })
        .then((data: Buffer) => new SourceMapConsumer(data.toString()))
        .catch((err) => {
          if (err !== null) {
            console.error("failed to read sourcemap", err);
          }
          return null;
        });
    }
    return this.mConsumers[relPath];
  }

  private async readSourceFile(filename: string): Promise<Buffer> {
    const root = await fs.realpath(this.mSourcePath);
    const resolved = await fs.realpath(filename);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Source map files must stay inside the source directory");
    }
    return fs.readFile(resolved);
  }
}

export default SourceMap;
