type IssueBase = {
  message: string;
  input: string;
  inst: string;
};

type InvalidTypeIssue = IssueBase & {
  code: "invalid_type";
  expected: string;
};

type UnknownKeysIssue = IssueBase & {
  code: "unrecognized_keys";
  keys: string[];
  note: string;
};

type Issue = InvalidTypeIssue | UnknownKeysIssue;

function issue(message: string, input: string, inst: string): IssueBase {
  return {
    message,
    input,
    inst,
  };
}

function collectIssues(): Issue[] {
  const issues: Issue[] = [];

  issues.push({
    ...issue("Wrong type", "payload", "context"),
    code: "invalid_type",
    expected: "string",
  });

  issues.push({
    ...issue("Unexpected keys", "payload", "context"),
    code: "unrecognized_keys",
    keys: ["extra"],
    note: "stale",
  });

  return issues;
}

for (const current of collectIssues()) {
  console.log(current.message);

  if (current.code === "unrecognized_keys") {
    console.log(current.inst);
    console.log(current.keys[0]);
  }
}
