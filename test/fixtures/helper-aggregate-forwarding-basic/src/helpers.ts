export type IssueData = {
  message: string;
  path: string[];
  fatal: boolean;
  extra: string;
};

type ParseContext = {
  issues: IssueData[];
};

function makeIssue(payload: { issueData: IssueData }): IssueData {
  return {
    ...payload.issueData,
  };
}

export function addIssueToContext(ctx: ParseContext, issueData: IssueData): void {
  ctx.issues.push(makeIssue({ issueData }));
}
