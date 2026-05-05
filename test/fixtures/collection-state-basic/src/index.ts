type ReplacementRow = {
  keep?: number;
  dead?: number;
  live?: number;
  stale?: number;
  nested?: { keep: string; dead?: string };
};

const stack = [{ live: 1, stale: 2 }];
console.log(stack[0].live);
stack.push({ live: 3, stale: 4 });
console.log(stack.pop()?.live);

const replaced: ReplacementRow[] = [
  { keep: 1, dead: 2 },
  { live: 3, stale: 4, nested: { keep: "a", dead: "x" } },
];
console.log(replaced[0].keep);
replaced[1] = { live: 5, nested: { keep: "b" } };
console.log(replaced[1].live);

const reordered = [{ live: 1, dead: 2 }];
reordered.reverse();
console.log(reordered[0].live);

const nested = [
  { items: [{ live: 1, dead: 2 }], safe: { keep: 1, stale: 2 } },
  { items: [{ live: 3, dead: 4 }], safe: { keep: 3, stale: 4 } },
];
nested[0].items.push({ live: 5, dead: 6 });
console.log(nested[0].safe.keep);
console.log(nested[1].safe.keep);

const opaque = [{ live: 1, dead: 2 }];
Object.freeze(opaque);
console.log(opaque[0].live);
