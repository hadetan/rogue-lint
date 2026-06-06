type ParseContext = {
  async: boolean;
};

type Schema<TDef = unknown> = {
  _zod: {
    def: TDef;
    run(payload: ParsePayload, ctx: ParseContext): ParsePayload;
    parse(payload: ParsePayload, ctx: ParseContext): ParsePayload;
  };
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

type ParsePayload = {
  value: Record<string, unknown>;
  issues: Issue[];
};

type LeafDef = {
  knownKeys: readonly string[];
};

type IntersectionDef = {
  left: Schema;
  right: Schema;
};

function createSchema<TDef>(initializer: (inst: Schema<TDef>, def: TDef) => void): (def: TDef) => Schema<TDef> {
  return (def) => {
    const inst: Schema<TDef> = {
      _zod: {
        def,
        run: (payload, _ctx) => payload,
        parse: (payload, _ctx) => payload,
      },
    };

    initializer(inst, def);
    return inst;
  };
}

const createLeafSchema = createSchema<LeafDef>((inst, def) => {
  inst._zod.run = (payload, ctx) => inst._zod.parse(payload, ctx);

  inst._zod.parse = (payload, ctx) => {
    void ctx.async;

    payload.issues.push({
      code: "invalid_type",
      expected: "never",
      input: payload.value,
      inst,
    });

    const unrecognized: string[] = [];

    for (const key in payload.value) {
      if (!def.knownKeys.includes(key)) {
        unrecognized.push(key);
      }
    }

    if (unrecognized.length > 0) {
      payload.issues.push({
        code: "unrecognized_keys",
        keys: unrecognized,
        input: payload.value,
        inst,
      });
    }

    return payload;
  };
});

function handleIntersectionResults(
  result: ParsePayload,
  left: ParsePayload,
  right: ParsePayload,
): ParsePayload {
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

  if (bothKeys.length > 0 && unrecognizedIssue) {
    result.issues.push({ ...unrecognizedIssue, keys: bothKeys });
  }

  return result;
}

const createIntersectionSchema = createSchema<IntersectionDef>((inst, def) => {
  inst._zod.run = (payload, ctx) => inst._zod.parse(payload, ctx);

  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);

    return handleIntersectionResults(payload, left, right);
  };
});

function firstSharedUnknownKey(payload: ParsePayload): string {
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

const leaf = createLeafSchema({ knownKeys: ["known"] });
const schema = createIntersectionSchema({ left: leaf, right: leaf });
const result = schema._zod.run(
  {
    value: {
      known: "value",
      shared: true,
      extra: true,
    },
    issues: [],
  },
  { async: false },
);

console.log(firstSharedUnknownKey(result));
