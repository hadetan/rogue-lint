const formatDictionary = {
  regex: {
    label: "Regex",
    gender: "neutral",
    dead: "regex-dead",
  },
  template_literal: {
    label: "Template literal",
    gender: "neutral",
    dead: "template-dead",
  },
  uuidv4: {
    label: "UUID v4",
    gender: "neutral",
    dead: "uuid-dead",
  },
} as const;

type Issue = {
  format: "regex" | "template_literal";
};

function render(issue: Issue): void {
  const selected = formatDictionary[issue.format];
  console.log(selected.label);
  console.log(selected.gender);
  console.log(formatDictionary[issue.format].label);
}

render({ format: Math.random() > 0.5 ? "regex" : "template_literal" });
