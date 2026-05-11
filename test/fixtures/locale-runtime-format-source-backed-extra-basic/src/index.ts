type DeclaredStringFormats = "email" | "url" | "regex";

type InvalidStringFormatIssue = {
  code: "invalid_format";
  format: DeclaredStringFormats | (string & {});
  input: string;
  pattern?: string;
};

type CommonFormatsIssue = InvalidStringFormatIssue & {
  format: Exclude<DeclaredStringFormats, "regex">;
};

type RegexIssue = InvalidStringFormatIssue & {
  format: "regex";
  pattern: string;
};

type StringFormatIssue = CommonFormatsIssue | RegexIssue;

const macCheckDef = {
  check: "string_format",
  format: "mac",
};

function emitTemplateLiteralIssue(format?: string): InvalidStringFormatIssue {
  return {
    code: "invalid_format",
    format: format ?? "template_literal",
    input: "payload",
  };
}

const formatDictionary: {
  [key in DeclaredStringFormats | (string & {})]?: string;
} = {
  regex: "input",
  email: "email address",
  url: "URL",
  mac: "MAC address",
  template_literal: "input",
  uuidv4: "UUIDv4",
  uuidv6: "UUIDv6",
};

function render(issue: InvalidStringFormatIssue): string {
  const _issue = issue as StringFormatIssue;
  if (_issue.format === "regex") {
    return `Pattern ${_issue.pattern}`;
  }

  return `Invalid ${formatDictionary[_issue.format] ?? issue.format}`;
}

console.log(macCheckDef.format);
console.log(render({ code: "invalid_format", format: "email", input: "value" }));
console.log(render(emitTemplateLiteralIssue()));