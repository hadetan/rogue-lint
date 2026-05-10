type IssueBase = {
  message: string;
  code: "custom" | "unrecognized_keys";
  input: string;
  inst: string;
};

type UnknownKeysIssue = IssueBase & {
  code: "unrecognized_keys";
  keys: string[];
};

type Issue = IssueBase | UnknownKeysIssue;

function issue(iss: IssueBase): IssueBase {
  return { ...iss };
}

function addIssue(payload: { issues: Issue[] }, raw: Omit<UnknownKeysIssue, "code">): void {
  payload.issues.push(
    issue({
      message: raw.message,
      code: "unrecognized_keys",
      input: raw.input,
      inst: raw.inst,
    }) as UnknownKeysIssue,
  );

  const current = payload.issues[payload.issues.length - 1] as UnknownKeysIssue;
  current.keys = raw.keys;
}

const payload: { issues: Issue[] } = { issues: [] };

addIssue(payload, {
  message: "Unexpected keys",
  input: "payload",
  inst: "context",
  keys: ["extra"],
});

for (const current of payload.issues) {
  console.log(current.message);
  console.log(current.input);
  console.log(current.inst);

  if (current.code === "unrecognized_keys") {
    console.log(current.keys[0]);
  }
}
