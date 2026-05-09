function buildRegexSource(suffix: string): string {
  let regex = `prefix:${suffix}`;
  regex = `${regex}:tail`;
  return regex;
}

const EVALUATING = Symbol("evaluating");

function defineLazy(getter: () => number): number | undefined {
  let value: number | typeof EVALUATING | undefined = undefined;

  const read = (): number | undefined => {
    if (value === EVALUATING) {
      return undefined;
    }

    if (value === undefined) {
      value = EVALUATING;
      value = getter();
    }

    return value;
  };

  return read();
}

console.log(buildRegexSource("body"));
console.log(defineLazy(() => 1));