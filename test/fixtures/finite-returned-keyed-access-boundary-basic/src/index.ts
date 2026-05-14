const entries: Record<string, { label: string; dead: string }> = {
  email: {
    label: "Email",
    dead: "email-dead",
  },
  url: {
    label: "URL",
    dead: "url-dead",
  },
};

function readEntry(format: string) {
  return entries[format];
}

const format = Math.random() > 0.5 ? "email" : `extra-${Date.now()}`;
const current = readEntry(format);

if (current) {
  console.log(current.label);
}
