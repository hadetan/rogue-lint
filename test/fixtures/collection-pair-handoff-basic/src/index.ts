type Invalid = {
  status: "aborted";
};

type Value<T> = {
  status: "dirty" | "valid";
  value: T;
};

type SyncParseReturnType<T> = Invalid | Value<T>;
type ParseReturnType<T> = SyncParseReturnType<T>;

type PairInput = {
  key: ParseReturnType<string>;
  value: ParseReturnType<number>;
  alwaysSet?: boolean;
};

type SyncPair = {
  key: SyncParseReturnType<string>;
  value: SyncParseReturnType<number>;
  alwaysSet?: boolean;
};

function mergeObjectSync(pairs: SyncPair[]): Record<string, number> {
  const finalObject: Record<string, number> = {};

  for (const pair of pairs) {
    const { key, value } = pair;

    if (key.status === "aborted" || value.status === "aborted") {
      return finalObject;
    }

    if (key.status === "dirty" || value.status === "dirty") {
      console.log("dirty");
    }

    if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
      finalObject[key.value] = value.value;
    }
  }

  return finalObject;
}

function buildPairs(extraKeys: string[]): PairInput[] {
  const pairs: PairInput[] = [];

  for (const key of extraKeys) {
    pairs.push({
      key: { status: "valid", value: key },
      value: { status: "valid", value: key.length },
      alwaysSet: key.length > 0,
    });
  }

  return pairs;
}

function materializePairs(pairs: PairInput[]): SyncPair[] {
  const syncPairs: SyncPair[] = [];

  for (const pair of pairs) {
    const key = pair.key;
    const value = pair.value;

    syncPairs.push({
      key,
      value,
      alwaysSet: pair.alwaysSet,
    });
  }

  return syncPairs;
}

const pairs = buildPairs(["alpha", "beta"]);
const syncPairs = materializePairs(pairs);

console.log(mergeObjectSync(pairs as SyncPair[]).alpha);
console.log(mergeObjectSync(syncPairs).beta);
