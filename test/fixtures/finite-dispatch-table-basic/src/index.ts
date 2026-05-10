import { initializeContext } from "./context.js";
import { allProcessors, type ProcessContext, type Schema } from "./processors.js";

function toOutput(schema: Schema, ctx: ProcessContext): string {
  const def = schema._zod.def;
  const json = { live: "" };
  const processor = ctx.processors[def.type];
  processor(schema, ctx, json);
  return json.live;
}

const baseParams = {
  target: "draft-07",
  metadata: new Map([["format", "ignored"]]),
};

const ctx = initializeContext({
  ...baseParams,
  processors: allProcessors,
});

console.log(toOutput({ _zod: { def: { type: "string" } }, value: "person@example.com" }, ctx));
console.log(toOutput({ _zod: { def: { type: "number" } }, value: 42 }, ctx));
