import { publicSchema } from "./index.js";

const methodName: string = Math.random() > 0.5 ? "validate" : "parse";
const schema = publicSchema();
const callback = (schema["~standard"] as Record<string, (input: unknown) => { value: string } | { issues: { message: string }[] }>)[methodName];

if (callback) {
  const result = callback("valid");
  if ("value" in result) {
    console.log(result.value.length);
  }
}
