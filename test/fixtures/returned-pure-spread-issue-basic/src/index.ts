type RawIssue = {
  message: string;
  code: "custom";
  input: string;
  inst: string;
};

function issue(iss: RawIssue): RawIssue {
  return { ...iss };
}

const created = issue({
  message: "Unexpected value",
  code: "custom",
  input: "payload",
  inst: "context",
});

console.log(created.message);
console.log(created.code);
console.log(created.input);
console.log(created.inst);
