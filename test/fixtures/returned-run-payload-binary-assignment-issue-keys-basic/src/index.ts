type ParseContext = {
  async: boolean;
};

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

const schema: {
  _zod: {
    run(payload: ParsePayload, ctx: ParseContext): ParsePayload;
    parse(payload: ParsePayload, ctx: ParseContext): ParsePayload;
  };
} = {
  _zod: {
    run: (payload, _ctx) => payload,
    parse: (payload, _ctx) => payload,
  },
};

schema._zod.run = (payload, ctx) => schema._zod.parse(payload, ctx);

schema._zod.parse = (payload, ctx) => {
  void ctx.async;
  const unrecognized: string[] = [];
  unrecognized.push("extra");

  if (unrecognized.length > 0) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
    });
  }

  return payload;
};

const result = schema._zod.run({ issues: [] }, { async: false });

function firstUnknownKey(payload: ParsePayload): string {
  for (const iss of payload.issues) {
    if (iss.code === "unrecognized_keys") {
      return iss.keys[0] ?? "none";
    }

    console.log(iss.expected);
  }

  return "none";
}

console.log(firstUnknownKey(result));
