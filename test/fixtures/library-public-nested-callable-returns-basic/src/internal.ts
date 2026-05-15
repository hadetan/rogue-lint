import { defineLazy } from "./helpers.js";

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

  throw new Error("async fallback");
}

function safeParseAsync(input: unknown): Promise<ParseResult> {
  if (typeof input === "string") {
    return Promise.resolve({ success: true, data: input });
  }

  return Promise.resolve({
    success: false,
    error: {
      issues: [issue("Expected string")],
    },
  });
}

export const publicSchema = {} as {
  "~standard": {
    validate(input: unknown): ValidationResult | Promise<ValidationResult>;
  };
};

defineLazy(publicSchema, "~standard", () => ({
  validate: (input: unknown): ValidationResult | Promise<ValidationResult> => {
    try {
      const result = safeParse(input);
      return result.success ? { value: result.data } : { issues: result.error.issues };
    } catch {
      return safeParseAsync(input).then((result) => (result.success ? { value: result.data } : { issues: result.error.issues }));
    }
  },
}));
