const formatDictionary = {
  regex: {
    label: "Regex",
    gender: "n",
    dead: "regex-dead",
  },
  template_literal: {
    label: "Template literal",
    gender: "n",
    dead: "template-dead",
  },
  uuidv4: {
    label: "UUID v4",
    gender: "n",
    dead: "uuid-dead",
  },
} as const;

type Issue = {
  format: "regex" | "template_literal";
};

function render(issue: Issue): string {
  const nounEntry = formatDictionary[issue.format];
  const noun = nounEntry?.label ?? issue.format;
  const adjective = nounEntry?.gender === "n" ? "valid" : "invalid";
  return `${noun}:${adjective}`;
}

console.log(render({ format: Math.random() > 0.5 ? "regex" : "template_literal" }));
