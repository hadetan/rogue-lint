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

function countSharedUnknownKeys(
  left: ParsePayload<Record<string, unknown>>,
  right: ParsePayload<Record<string, unknown>>,
): number {
  const sharedLeftKeys = new Set<string>();

  for (const iss of left.issues) {
    if (iss.code === "unrecognized_keys") {
      console.log(iss.input);
      console.log(iss.inst);

      for (const key of iss.keys) {
        sharedLeftKeys.add(key);
      }
    } else {
      console.log(iss.expected);
    }
  }

  let shared = 0;

  for (const iss of right.issues) {
    if (iss.code === "unrecognized_keys") {
      console.log(iss.input);
      console.log(iss.inst);

      for (const key of iss.keys) {
        if (sharedLeftKeys.has(key)) {
          shared += 1;
        }
      }
    } else {
      console.log(iss.expected);
    }
  }

  return shared;
}

const schema = createObjectSchema(["known"]);

const left = parse(schema, {
  known: "left",
  extra: true,
});

const right = parse(schema, {
  known: "right",
  extra: false,
});

console.log(countSharedUnknownKeys(left, right));
