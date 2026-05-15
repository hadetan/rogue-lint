type Issue = {
  message: string;
};

type ParseResult =
  | { success: true; data: string }
  | { success: false; error: { issues: Issue[] } };

type ValidationResult =
  | { value: string }
  | { issues: Issue[] };

function issue(message: string): Issue {
  return { message };
}

function safeParse(input: unknown): ParseResult {
  if (typeof input === "string") {
    return { success: true, data: input };
  }

  return {
    success: false,
    error: {
      issues: [issue("Expected string")],
    },
  };
}

export function publicSchema() {
  return {
    "~standard": {
      validate(input: unknown): ValidationResult {
        const result = safeParse(input);
        return result.success ? { value: result.data } : { issues: result.error.issues };
      },
    },
  };
}