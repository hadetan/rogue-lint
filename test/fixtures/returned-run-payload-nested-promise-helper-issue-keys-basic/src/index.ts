type InvalidTypeIssue = {
  code: "invalid_type";
  expected: string;
};

type UnrecognizedKeysIssue = {
  code: "unrecognized_keys";
  keys: string[];
};

type Issue = InvalidTypeIssue | UnrecognizedKeysIssue;

type ParsePayload = {
  value: Record<string, unknown>;
  issues: Issue[];
};

function handlePropertyResult(
  result: ParsePayload,
  final: ParsePayload,
  key: string,
): void {
  if (result.issues.length) {
    final.issues.push(...result.issues);
  }

  final.value[key] = result.value;
}

function handleCatchall(
  input: Record<string, unknown>,
  payload: ParsePayload,
): ParsePayload | Promise<ParsePayload> {
  const unrecognized: string[] = [];
  const proms: Promise<ParsePayload>[] = [];

  for (const key in input) {
    if (key === "known") {
      continue;
    }

    unrecognized.push(key);
    const result = Promise.resolve({
      value: { [key]: input[key] },
      issues: [] as Issue[],
    });

    proms.push(result.then((resolved) => {
      handlePropertyResult(resolved, payload, key);
      return resolved;
    }));
  }

  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
    });
  }

  if (!proms.length) {
    return payload;
  }

  return Promise.all(proms).then(() => payload);
}

function runSide(input: Record<string, unknown>): ParsePayload {
  const result = handleCatchall(input, { value: {}, issues: [] });
  if (result instanceof Promise) {
    throw new Error("unexpected async result");
  }

  result.issues.push({
    code: "invalid_type",
    expected: "never",
  });
  return result;
}

function handleIntersectionResults(
  result: ParsePayload,
  left: ParsePayload,
  right: ParsePayload,
): ParsePayload {
  const unrecognizedKeys = new Map<string, { left?: true; right?: true }>();
  let unrecognizedIssue: Issue | undefined;

  for (const iss of left.issues) {
    if (iss.code === "unrecognized_keys") {
      unrecognizedIssue ??= iss;
      for (const key of iss.keys) {
        if (!unrecognizedKeys.has(key)) {
          unrecognizedKeys.set(key, {});
        }

        unrecognizedKeys.get(key)!.left = true;
      }
    } else {
      result.issues.push(iss);
    }
  }

  for (const iss of right.issues) {
    if (iss.code === "unrecognized_keys") {
      for (const key of iss.keys) {
        if (!unrecognizedKeys.has(key)) {
          unrecognizedKeys.set(key, {});
        }

        unrecognizedKeys.get(key)!.right = true;
      }
    } else {
      result.issues.push(iss);
    }
  }

  const sharedKeys = [...unrecognizedKeys]
    .filter(([, flags]) => flags.left && flags.right)
    .map(([key]) => key);

  if (sharedKeys.length && unrecognizedIssue && unrecognizedIssue.code === "unrecognized_keys") {
    result.issues.push({ ...unrecognizedIssue, keys: sharedKeys });
  }

  return result;
}

function firstSharedUnknownKey(payload: ParsePayload): string {
  for (const iss of payload.issues) {
    if (iss.code === "unrecognized_keys") {
      return iss.keys[0] ?? "none";
    }

    console.log(iss.expected);
  }

  return "none";
}

const left = runSide({
  known: true,
  shared: "left",
  leftOnly: 1,
});

const right = runSide({
  known: true,
  shared: "right",
  rightOnly: 2,
});

const merged = handleIntersectionResults({ value: {}, issues: [] }, left, right);

console.log(firstSharedUnknownKey(merged));
