export type Issue = {
  path: string[];
  message: string;
};

export type FlattenedErrors = {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
};

export function flattenError(issues: Issue[]): FlattenedErrors {
  const fieldErrors: Record<string, string[]> = Object.create(null);
  const formErrors: string[] = [];

  for (const issue of issues) {
    if (issue.path.length > 0) {
      const first = issue.path[0]!;
      fieldErrors[first] = fieldErrors[first] || [];
      fieldErrors[first].push(issue.message);
    } else {
      formErrors.push(issue.message);
    }
  }

  return { formErrors, fieldErrors };
}
