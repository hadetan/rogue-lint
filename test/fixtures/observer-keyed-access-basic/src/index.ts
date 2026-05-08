const observedEntries = {
  live: 1,
  stale: 2,
};

console.log(Object.entries(observedEntries).length);

const serialized = {
  live: 1,
  stale: 2,
  nested: {
    keep: 3,
    dead: 4,
  },
};

JSON.stringify(serialized.nested);

const keyed = {
  live: 1,
  dead: 2,
  nested: {
    live: 3,
    dead: 4,
  },
};

const key = "live" as const;
console.log(keyed[key]);
console.log(keyed.nested[key]);

const dynamic = {
  live: 1,
  dead: 2,
};

const dynamicKey = process.argv[2] ?? "live";
console.log(dynamic[dynamicKey]);

const untouched = {
  live: 1,
  dead: 2,
};

console.log(untouched.live);
