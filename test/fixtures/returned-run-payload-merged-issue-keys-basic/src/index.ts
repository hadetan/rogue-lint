type ParseContext = {
  async: boolean;
};

type InvalidTypeIssue = {
  code: "invalid_type";
  expected: string;
  input: Record<string, unknown>;
  inst: Schema;
};

type UnrecognizedKeysIssue = {
  code: "unrecognized_keys";
  keys: string[];
  input: Record<string, unknown>;
  inst: Schema;
};

type Issue = InvalidTypeIssue | UnrecognizedKeysIssue;

type ParsePayload<T = unknown> = {
  value: T;
  issues: Issue[];
};

type Schema = {
  _zod: {
    run(payload: ParsePayload<Record<string, unknown>>, ctx: ParseContext): ParsePayload<Record<string, unknown>>;
  };
};

function createObjectSchema(knownKeys: readonly string[]): Schema {
  const schema: Schema = {
    _zod: {
      run(payload, ctx) {
        void ctx.async;

        payload.issues.push({
          code: "invalid_type",
          expected: "never",
          input: payload.value,
          inst: schema,
        });

        const unrecognized: string[] = [];

        for (const key in payload.value) {
          if (!knownKeys.includes(key)) {
            unrecognized.push(key);
          }
        }

        if (unrecognized.length) {
          payload.issues.push({
            code: "unrecognized_keys",
            keys: unrecognized,
            input: payload.value,
            inst: schema,
          });
        }

        return payload;
      },
    },
  };

  return schema;
}

function parse(schema: Schema, value: Record<string, unknown>): ParsePayload<Record<string, unknown>> {
  const ctx: ParseContext = { async: false };
  return schema._zod.run({ value, issues: [] }, ctx);
}

function handleIntersectionResults(result: ParsePayload, left: ParsePayload, right: ParsePayload): ParsePayload {
  const unrecognizedKeys = new Map<string, { left?: true; right?: true }>();
  let unrecognizedIssue: UnrecognizedKeysIssue | undefined;

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

  const bothKeys = [...unrecognizedKeys]
    .filter(([, flags]) => flags.left && flags.right)
    .map(([key]) => key);

  if (bothKeys.length && unrecognizedIssue) {
    result.issues.push({ ...unrecognizedIssue, keys: bothKeys });
  }

  return result;
}

function mergePayloads(
  left: ParsePayload<Record<string, unknown>>,
  right: ParsePayload<Record<string, unknown>>,
): ParsePayload<Record<string, unknown>> {
  return handleIntersectionResults({ value: left.value, issues: [] }, left, right);
}

function firstSharedUnknownKey(payload: ParsePayload<Record<string, unknown>>): string {
  for (const iss of payload.issues) {
    if (iss.code === "unrecognized_keys") {
      console.log(iss.input);
      console.log(iss.inst);
      return iss.keys[0] ?? "none";
    }

    console.log(iss.expected);
  }

  return "none";
}

const schema = createObjectSchema(["known"]);

const left = parse(schema, {
  known: "left",
  shared: true,
  leftOnly: 1,
});

const right = parse(schema, {
  known: "right",
  shared: false,
  rightOnly: 2,
});

const merged = mergePayloads(left, right);

console.log(firstSharedUnknownKey(merged));
