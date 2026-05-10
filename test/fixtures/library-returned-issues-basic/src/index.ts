export interface RawIssue {
  message: string;
  code: "custom";
  input: string;
  inst: string;
  keys?: string[];
}

function issue(message: string, input: string, inst: string): RawIssue {
  return {
    message,
    code: "custom",
    input,
    inst,
  };
}

export function collectUnknown(input: Record<string, string>): RawIssue[] {
  const unrecognized: string[] = [];

  for (const key in input) {
    if (key !== "known") {
      unrecognized.push(key);
    }
  }

  const issues: RawIssue[] = [];
  if (unrecognized.length > 0) {
    issues.push({
      ...issue("Unexpected keys", "payload", "context"),
      keys: unrecognized,
    });
  }

  return issues;
}
