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
  issues: Issue[];
};

function collectIssues(
  payload: ParsePayload,
  input: Record<string, unknown>,
): ParsePayload | Promise<ParsePayload> {
  const unrecognized: string[] = [];
  const proms: Promise<unknown>[] = [];

  for (const key in input) {
    if (key === "known") {
      continue;
    }

    unrecognized.push(key);
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

function collectSyncIssues(input: Record<string, unknown>): ParsePayload {
  const result = collectIssues({ issues: [] }, input);

  if (result instanceof Promise) {
    throw new Error("unexpected async result");
  }

  return result;
}

function firstUnknown(payload: ParsePayload): string {
  for (const iss of payload.issues) {
    if (iss.code === "unrecognized_keys") {
      return iss.keys[0] ?? "none";
    }

    console.log(iss.expected);
  }

  return "none";
}

const payload = collectSyncIssues({
  known: true,
  extra: 1,
});

console.log(firstUnknown(payload));
