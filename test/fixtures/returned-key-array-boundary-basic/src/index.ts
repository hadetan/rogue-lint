type UnknownKeysIssue = {
  code: "unrecognized_keys";
  keys: string[];
};

const retainedKeys: string[][] = [];

function rememberKeys(keys: string[]): void {
  retainedKeys.push(keys);
}

function collectIssue(): UnknownKeysIssue {
  const keys: string[] = [];
  keys.push("extra");
  return {
    code: "unrecognized_keys",
    keys,
  };
}

const issue = collectIssue();
rememberKeys(issue.keys);

console.log(retainedKeys.length);
