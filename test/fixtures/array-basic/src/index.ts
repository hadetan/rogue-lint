const direct = [10, 20, 30];
console.log(direct[0]);
console.log(direct.at(-1));

const pair = ["left", "right"];
const [first] = pair;
console.log(first);

const rows = [
  { enabled: true, stale: 1, nested: { keep: "a", dead: "x" } },
  { enabled: false, stale: 2, nested: { keep: "b", dead: "y" } },
];

for (const row of rows) {
  console.log(row.enabled, row.nested.keep);
}

const groups = [
  { items: [{ live: 1, dead: 2 }] },
  { items: [{ live: 3, dead: 4 }] },
];

groups.forEach((group) => {
  console.log(group.items[0].live);
});

const dynamicRows = [
  { live: 1, dead: 2 },
  { live: 3, dead: 4 },
];
const dynamicIndex = Number.parseInt("0", 10);
console.log(dynamicRows[dynamicIndex].live);

const dynamicAt = ["alpha", "beta"];
const atIndex = Number.parseInt("1", 10);
console.log(dynamicAt.at(atIndex));

const spreadRows = [{ live: 1, dead: 2 }];
const copied = [...spreadRows];
console.log(copied.length);

const mutatedRows = [{ live: 1, dead: 2 }];
mutatedRows.sort(() => 0);
console.log(mutatedRows[0].live);

const restValues = [1, 2, 3];
const [head, ...tail] = restValues;
console.log(head, tail.length);
