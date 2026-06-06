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

type Check = {
  _zod: {
    def: {
      when?: (payload: ParsePayload) => boolean;
    };
    check: (payload: ParsePayload) => void;
  };
};

function createParser(): (value: Record<string, unknown>) => ParsePayload {
  const checks: Check[] = [
    {
      _zod: {
        def: {
          when(payload) {
            return payload.value.extra === true;
          },
        },
        check(payload) {
          const unrecognized = ["extra"];
          payload.issues.push({
            code: "unrecognized_keys",
            keys: unrecognized,
            input: payload.value,
          });
        },
      },
    },
    {
      _zod: {
        def: {},
        check(payload) {
          payload.issues.push({
            code: "invalid_type",
            expected: "never",
            input: payload.value,
          });
        },
      },
    },
  ];

  function runChecks(payload: ParsePayload): ParsePayload {
    for (const ch of checks) {
      if (ch._zod.def.when) {
        if (!ch._zod.def.when(payload)) {
          continue;
        }
      }

      ch._zod.check(payload);
    }

    return payload;
  }

  return (value) => runChecks({ value, issues: [] });
}

function firstUnknownKey(payload: ParsePayload): string {
  for (const issue of payload.issues) {
    if (issue.code === "unrecognized_keys") {
      console.log(issue.input);
      return issue.keys[0] ?? "none";
    }

    console.log(issue.expected);
  }

  return "none";
}

const parse = createParser();
const result = parse({ known: "value", extra: true });

console.log(firstUnknownKey(result));
