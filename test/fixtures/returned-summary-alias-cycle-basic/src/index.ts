type Summary = {
  live: string;
  dead: string;
};

function buildSummary(): Summary {
  return {
    live: "ok",
    dead: "stale",
  };
}

function cycleCarrier(summary: Summary) {
  const aliasA = { current: summary };
  const aliasB = { current: aliasA.current };

  aliasA.current = aliasB.current;
  aliasB.current = aliasA.current;

  return {
    current: aliasA.current,
    getSummary() {
      return aliasB.current;
    },
  };
}

const carrier = cycleCarrier(buildSummary());
const summary = carrier.getSummary();

console.log(carrier.current.live);
console.log(summary.live);
