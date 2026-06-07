import { addIssueToContext, type IssueData } from "./helpers.js";

const context: { issues: IssueData[] } = {
  issues: [],
};

const issueData: IssueData = {
  message: "Unexpected keys",
  path: ["root"],
  fatal: true,
  extra: "unused",
};

addIssueToContext(context, issueData);

const current = context.issues[0];
console.log(current.message);
console.log(current.path[0]);

if (current.fatal) {
  console.log(current.extra);
}
