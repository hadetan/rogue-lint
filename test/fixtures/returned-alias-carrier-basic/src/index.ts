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

function buildCarrier() {
  const trackedObject = buildSummary();
  const prefix = ["live", "dead"];

  return {
    trackedObject,
    prefix,
  };
}

const carrier = buildCarrier();
console.log(carrier.trackedObject.live);
console.log(carrier.prefix[0].length);
