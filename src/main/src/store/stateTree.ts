/** Restores persisted keys as own properties, including names such as __proto__. */
export function insertStateValue(
  target: Record<string, unknown>,
  key: string[],
  value: unknown,
): void {
  let current = target;
  for (const [index, segment] of key.entries()) {
    const existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
    const child =
      index === key.length - 1
        ? value
        : existing !== null && typeof existing === "object"
          ? existing
          : {};
    Object.defineProperty(current, segment, {
      value: child,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    current = child as Record<string, unknown>;
  }
}
