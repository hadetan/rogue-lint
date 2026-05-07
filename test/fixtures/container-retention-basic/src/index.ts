type RecordShape = {
  live: number;
  dead: number;
};

function retainRecord(record: RecordShape, key: string) {
  const retained = new Map<string, RecordShape>();
  retained.set(key, record);
  const restored = retained.get(key);
  if (!restored) {
    throw new Error("missing retained record");
  }
  return restored;
}

const record = {
  live: 1,
  dead: 2,
};

const restored = retainRecord(record, "chosen");
console.log(restored.live);
