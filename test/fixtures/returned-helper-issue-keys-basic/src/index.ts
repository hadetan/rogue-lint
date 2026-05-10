type IssueBase = {
  message: string;
  code: "unrecognized_keys";
  input: string;
  inst: string;
};

type UnknownKeysIssue = IssueBase & {
  keys: string[];
  note: string;
};

function issue(message: string, input: string, inst: string): IssueBase {
  return {
    message,
    code: "unrecognized_keys",
    input,
    inst,
  };
}

function buildIssue(): UnknownKeysIssue {
  return {
    ...issue("Unexpected keys", "payload", "context"),
    keys: ["extra"],
    note: "stale",
  };
}

const created = buildIssue();
console.log(created.message);
console.log(created.code);
console.log(created.input);
console.log(created.inst);
console.log(created.keys[0]);
