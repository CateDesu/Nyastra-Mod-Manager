import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve("fork-ts-checker-webpack-plugin"));
const merge = pluginRequire("deepmerge");

test("build merging keeps dictionary keys from changing result prototypes", () => {
  const payload = JSON.parse('{"__proto__":{"inherited":true},"nested":{"enabled":true}}');
  for (const [target, source] of [
    [payload, {}],
    [Object.create(null), payload],
    [{ nested: payload }, { nested: {} }],
  ]) {
    const result = merge(target, source);
    const dictionary = target.nested === payload ? result.nested : result;
    assert.equal(Object.getPrototypeOf(dictionary), Object.prototype);
    assert.equal(dictionary.inherited, undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptor(dictionary, "__proto__"), {
      value: { inherited: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
});

test("build merging preserves arrays, symbols, callbacks and source ownership", () => {
  const key = Symbol("configuration");
  const callback = () => true;
  const target = { options: { strict: true }, include: ["first"], [key]: callback };
  const source = { options: { verbose: true }, include: ["second"] };
  const result = merge(target, source);
  assert.deepEqual(result, {
    options: { strict: true, verbose: true },
    include: ["first", "second"],
    [key]: callback,
  });
  assert.deepEqual(target.include, ["first"]);
  assert.deepEqual(source.options, { verbose: true });
  assert.notEqual(result.options, target.options);
  assert.deepEqual(merge.all([{ files: [1] }, { files: [2] }]), { files: [1, 2] });
  assert.deepEqual(merge(target, source, { arrayMerge: (_left, right) => right }).include, [
    "second",
  ]);
  assert.deepEqual(
    merge(
      { options: { strict: true } },
      { options: { verbose: true } },
      {
        customMerge: () => (_left, right) => right,
      },
    ),
    { options: { verbose: true } },
  );
  const Plugin = require("fork-ts-checker-webpack-plugin");
  const plugin = new Plugin({
    typescript: { configOverwrite: { compilerOptions: { strict: true } } },
  });
  assert.equal(plugin.options.typescript.configOverwrite.compilerOptions.strict, true);
});

test("build merging retains own fields when intrinsic defaults are frozen", () => {
  execFileSync(process.execPath, [
    "--input-type=commonjs",
    "-e",
    `
      const assert = require("node:assert/strict");
      Object.freeze(Object.prototype);
      const merge = require(process.argv[1]);
      for (const [target, source] of [
        [{ toString: "target" }, {}],
        [Object.create(null), { toString: "source" }],
      ]) {
        const result = merge(target, source);
        assert.equal(Object.getPrototypeOf(result), Object.prototype);
        assert.equal(Object.hasOwn(result, "toString"), true);
        assert.equal(result.toString, source.toString === "source" ? "source" : "target");
      }
    `,
    pluginRequire.resolve("deepmerge"),
  ]);
});
