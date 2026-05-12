const entries = {
  email: {
    label: "Email",
    dead: "email-dead",
  },
  url: {
    label: "URL",
    dead: "url-dead",
  },
  unused: {
    label: "Unused",
    dead: "unused-dead",
  },
};

type Format = "email" | "url";

function readEntry(format: Format) {
  return entries[format];
}

const format: Format = Math.random() > 0.5 ? "email" : "url";
const current = readEntry(format);

console.log(current.label);