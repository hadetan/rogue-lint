type RawIssue = {
  message: string;
  code: "custom";
  input: string;
  inst: string;
  continue: boolean;
};

function issue(_iss: string, input: string, inst: string): RawIssue;
function issue(_iss: RawIssue): RawIssue;
function issue(...args: [string | RawIssue, string?, string?]): RawIssue {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input: input ?? "missing-input",
      inst: inst ?? "missing-inst",
      continue: true,
    };
  }

  return { ...iss };
}

function addIssue(source: string | Partial<RawIssue>): RawIssue {
  if (typeof source === "string") {
    return issue(source, "payload", "context");
  }

  const current = source as Partial<RawIssue>;
  current.message ??= "Unexpected value";
  current.code ??= "custom";
  current.input ??= "payload";
  current.inst ??= "context";
  current.continue ??= true;
  return issue(current as RawIssue);
}

const created = addIssue({ message: "Unexpected value" });
console.log(created.message);
console.log(created.input);
console.log(created.inst);
console.log(created.continue);
