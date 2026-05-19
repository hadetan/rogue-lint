type Issue = {
  message: string;
};

type ParseResult =
  | { success: true; data: string }
  | { success: false; error: { issues: Issue[] } };

type ValidationResult =
  | { success: true; data: string }
  | { success: false; issues: Issue[] };

function safeParse(input: unknown): ParseResult {
  if (typeof input === "string") {
    return { success: true, data: input };
  }

  return {
    success: false,
    error: {
      issues: [{ message: "Expected string" }],
    },
  };
}

function handleResult(input: unknown): ValidationResult {
  const result = safeParse(input);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, issues: result.error.issues };
}

const valid = handleResult("hello");
if (valid.success) {
  console.log(valid.data.toUpperCase());
}

const invalid = handleResult(42);
if (!invalid.success) {
  console.log(invalid.issues[0].message);
}
