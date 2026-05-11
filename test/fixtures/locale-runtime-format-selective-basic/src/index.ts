const formatDictionary: {
  regex: string;
  template_literal: string;
  mac: string;
  uuidv4: string;
  uuidv6: string;
} = {
  regex: "Regex",
  template_literal: "Template literal",
  mac: "MAC address",
  uuidv4: "UUID v4",
  uuidv6: "UUID v6",
};

type Issue = {
  format: "mac" | "regex" | "template_literal" | "uuid";
  pattern?: string;
  version?: "v4" | "v6";
};

function render(issue: Issue): void {
  if (issue.format === "regex") {
    console.log(issue.pattern);
    return;
  }

  if (issue.format === "uuid") {
    console.log(issue.version);
    return;
  }

  console.log(formatDictionary[issue.format] ?? issue.format);
}

render(Math.random() > 0.5 ? { format: "template_literal" } : { format: "mac" });
