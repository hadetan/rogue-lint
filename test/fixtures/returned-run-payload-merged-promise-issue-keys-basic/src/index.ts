import type * as errors from "./errors.js";

type ParseContext = {
  async: boolean;
};

type ParsePayload = {
  value: string;
  issues: errors.ZodRawIssue[];
};

function handleCatchall(
  input: Record<string, unknown>,
  payload: ParsePayload,
  ctx: ParseContext,
): ParsePayload | Promise<ParsePayload> {
  const unrecognized: string[] = [];
  const proms: Promise<unknown>[] = [];

  void ctx.async;

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

function runSide(value: Record<string, unknown>): ParsePayload | Promise<ParsePayload> {
  const result = handleCatchall(value, { value: "payload", issues: [] }, { async: false });

  if (result instanceof Promise) {
    return result.then((resolved) => {
      resolved.issues.push({
        code: "invalid_type",
        expected: "never",
      });
      return resolved;
    });
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
  let unrecognizedIssue: errors.ZodRawIssue | undefined;

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

  if (sharedKeys.length && unrecognizedIssue) {
    result.issues.push({ ...unrecognizedIssue, keys: sharedKeys });
  }

  return result;
}

function mergePayloads(
  left: ParsePayload | Promise<ParsePayload>,
  right: ParsePayload | Promise<ParsePayload>,
): ParsePayload | Promise<ParsePayload> {
  const result: ParsePayload = { value: "payload", issues: [] };
  const async = left instanceof Promise || right instanceof Promise;

  if (async) {
    return Promise.all([left, right]).then(([resolvedLeft, resolvedRight]) => {
      return handleIntersectionResults(result, resolvedLeft, resolvedRight);
    });
  }

  return handleIntersectionResults(result, left, right);
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
  known: "left",
  shared: true,
  leftOnly: 1,
});

const right = runSide({
  known: "right",
  shared: false,
  rightOnly: 2,
});

const merged = mergePayloads(left, right);

if (merged instanceof Promise) {
  throw new Error("unexpected async merge");
}

console.log(firstSharedUnknownKey(merged));
