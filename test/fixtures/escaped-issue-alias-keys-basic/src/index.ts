type InvalidTypeIssue = {
  code: "invalid_type";
  expected: string;
  input: Record<string, unknown>;
};

type UnrecognizedKeysIssue = {
  code: "unrecognized_keys";
  keys: string[];
  input: Record<string, unknown>;
};

type Issue = InvalidTypeIssue | UnrecognizedKeysIssue;

type ParsePayload = {
  value: Record<string, unknown>;
  issues: Issue[];
};

declare function publish(value: unknown): void;

const payload: ParsePayload = {
  value: {
    known: "value",
    extra: true,
  },
  issues: [],
};

const unrecognized: string[] = [];
for (const key in payload.value) {
  if (key !== "known") {
    unrecognized.push(key);
  }
}

payload.issues.push({
  code: "invalid_type",
  expected: "object",
  input: payload.value,
});

payload.issues.push({
  code: "unrecognized_keys",
  keys: unrecognized,
  input: payload.value,
});

publish(payload.issues[1]);
