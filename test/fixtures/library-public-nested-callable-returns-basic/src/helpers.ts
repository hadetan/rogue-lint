export function defineLazy<T extends object, K extends PropertyKey>(
  object: T,
  key: K,
  getter: () => K extends keyof T ? T[K] : unknown,
): void {
  let value: unknown;

  Object.defineProperty(object, key, {
    get() {
      if (value === undefined) {
        value = getter();
      }

      return value;
    },
    configurable: true,
  });
}
