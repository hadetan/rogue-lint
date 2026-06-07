const special = {
  d: "day",
  M: "month",
  unused: "stale",
};

function normalizeUnit(unit) {
  if (unit === "date") {
    return "d";
  }
  if (unit === "month") {
    return "M";
  }
  return unit;
}

function prettyUnit(unit) {
  return special[unit] || unit;
}

const labels = {
  date: prettyUnit(normalizeUnit("date")),
  month: prettyUnit(normalizeUnit("month")),
};

console.log(labels.date);
console.log(labels.month);

export default labels;