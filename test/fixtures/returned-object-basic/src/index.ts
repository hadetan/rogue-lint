function buildSummary() {
  const summary = {
    live: 1,
    dead: 2,
    nested: {
      read: 3,
      stale: 4,
    },
  };

  return summary;
}

function maybeReuse(): ReturnType<typeof buildSummary> | undefined {
  return undefined;
}

function chooseSummary() {
  return maybeReuse() ?? buildSummary();
}

console.log(chooseSummary().live);

const chosen = chooseSummary();
console.log(chosen.nested.read);
