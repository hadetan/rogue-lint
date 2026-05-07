import { Example } from "./model.js";
import { usedEnum, usedExport } from "./lib.js";

const example = new Example();
example.usedMethod();
console.log(usedExport, usedEnum.Red);

// rogue-lint-ignore-next
const ignoredLocal = 1;
const unusedLocal = 2;

const config = {
  used: 1,
  dead: 2,
  nested: {
    alive: true,
    stale: false
  }
};

console.log(config.used, config.nested.alive);

const dynamicBag = {
  maybe: 1,
  later: 2
};
const key = Math.random() > 0.5 ? "maybe" : "later";
console.log(dynamicBag[key]);
