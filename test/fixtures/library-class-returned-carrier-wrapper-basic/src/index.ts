export type Issue = {
  path: string[];
  message: string;
};

export class ValidationError {
  constructor(private readonly issues: Issue[]) {}

  flatten(): { formErrors: string[]; fieldErrors: Record<string, string[]> } {
    const fieldErrors: Record<string, string[]> = Object.create(null);
    const formErrors: string[] = [];

    for (const issue of this.issues) {
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
}
