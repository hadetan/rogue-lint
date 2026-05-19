import { publicSchema } from "./index.js";

const result = publicSchema["~standard"].validate("valid");

if (result instanceof Promise) {
  throw new Error("expected sync validation result");
}

if ("issues" in result) {
  throw new Error("expected successful validation result");
}

console.log(result.value.length);
