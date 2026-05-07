function buildSummary() {
  return {
    live: 1,
    dead: 2,
    nested: {
      read: 3,
      stale: 4,
    },
  };
}

buildSummary();
console.log(buildSummary().live);

const chosen = buildSummary();
console.log(chosen.nested.read);

function buildRows() {
  return [
    { keep: 1, stale: 2 },
    { keep: 3, stale: 4 },
  ];
}

const [first] = buildRows();
console.log(first.keep);
