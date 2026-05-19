type Summary = {
  live: string;
  dead: string;
};

const summary: Summary = {
  live: "ok",
  dead: "stale",
};

const carrier = {
  runtime: {
    summary,
  },
};

console.log(carrier.runtime.summary.live);
