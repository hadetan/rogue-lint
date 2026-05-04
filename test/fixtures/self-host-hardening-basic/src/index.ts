import path from "node:path";
import { Minimatch } from "minimatch";

import "./missing.js";

const defaults = {
  keep: {
    files: true,
    symbols: true
  },
  objectAnalysis: {
    enabled: true,
    maxPathDepth: 2
  }
};

const merged = {
  ...defaults,
  keep: {
    ...defaults.keep,
    files: Boolean(path.basename("demo.ts"))
  }
};

console.log(merged.objectAnalysis.enabled);

let depth = 0;
depth += 1;
console.log(depth);

const extensions = [".ts", ".js"];
for (const extension of extensions) {
  console.log(extension);
}

const stages = [
  {
    enabled: true,
    run: () => new Minimatch("*.ts").match("index.ts")
  },
  {
    enabled: false,
    run: () => false
  }
];

for (const stage of stages) {
  if (stage.enabled) {
    console.log(stage.run());
  }
}
