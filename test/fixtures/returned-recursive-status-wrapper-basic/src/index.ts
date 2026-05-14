type MergeResult =
  | { valid: true; data: unknown }
  | { valid: false; mergeErrorPath: (string | number)[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeValues(a: unknown, b: unknown): MergeResult {
  if (a === b) {
    return { valid: true, data: a };
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.includes(key));
    const mergedObject: Record<string, unknown> = { ...a, ...b };

    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath],
        };
      }
      mergedObject[key] = sharedValue.data;
    }

    return { valid: true, data: mergedObject };
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }

    const mergedArray: unknown[] = [];
    for (let index = 0; index < a.length; index++) {
      const sharedValue = mergeValues(a[index], b[index]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath],
        };
      }

      mergedArray.push(sharedValue.data);
    }

    return { valid: true, data: mergedArray };
  }

  return { valid: false, mergeErrorPath: [] };
}

const merged = mergeValues(
  { nested: { live: "ok" }, items: [1, 2] },
  { nested: { live: "ok" }, items: [1, 2] },
);

if (!merged.valid) {
  console.log(merged.mergeErrorPath.length);
} else {
  const payload = merged.data as { nested: { live: string }; items: number[] };
  console.log(payload.nested.live);
  console.log(payload.items[0]);
}
