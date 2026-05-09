const labels = {
  email: "Email",
  url: "URL",
  unused: "Unused",
} as const;

const entries = {
  email: {
    label: "Email",
    dead: 1,
  },
  url: {
    label: "URL",
    dead: 2,
  },
  unused: {
    label: "Unused",
    dead: 3,
  },
};

const format: "email" | "url" = Math.random() > 0.5 ? "email" : "url";

console.log(labels[format]);
const entry = entries[format];
console.log(entry.label);
console.log(entries[format].label);