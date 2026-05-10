export const processors = {
  string: () => "s",
  number: () => "n",
};

const kind: "string" | "number" = Math.random() > 0.5 ? "string" : "number";
console.log(processors[kind]());

function pickArguments(useEnd: boolean, slice: number): number[] {
  const argumentStart = [0, 0, 0, 0];
  const argumentEnd = [23, 59, 59, 999];
  return (useEnd ? argumentEnd : argumentStart).slice(slice);
}

console.log(pickArguments(true, 1).join(","));
