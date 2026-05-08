type SupportedRecord = {
  live: number;
  dead: number;
};

type UnsupportedRecord = {
  keep: number;
  stale: number;
};

function retainSupported(record: SupportedRecord) {
  const retained = Object.create(null) as { chosen?: SupportedRecord };
  retained.chosen = record;
  const restored = retained.chosen;
  if (!restored) {
    throw new Error("missing supported record");
  }
  return restored;
}

function retainUnsupported(record: UnsupportedRecord, key: string) {
  const retained = Object.create(null) as Record<string, UnsupportedRecord>;
  retained[key] = record;
  const restored = retained[key];
  if (!restored) {
    throw new Error("missing unsupported record");
  }
  return restored;
}

const supported = {
  live: 1,
  dead: 2,
};

const unsupported = {
  keep: 1,
  stale: 2,
};

const restored = retainSupported(supported);
console.log(restored.live);

const escaped = retainUnsupported(unsupported, process.argv[2] ?? "chosen");
console.log(escaped.keep);