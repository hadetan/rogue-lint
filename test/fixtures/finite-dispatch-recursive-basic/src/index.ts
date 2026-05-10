import { initializeContext } from "./context.js";
import { allProcessors, type ProcessContext, type Schema } from "./processors.js";

function process(schema: Schema, ctx: ProcessContext): string {
  const def = schema._zod.def as Schema["_zod"]["def"];
  const json = { live: "" };
  const processor = ctx.processors[def.type];
  processor(schema, ctx, json);

  const parent = schema._zod.parent;
  if (parent) {
    process(parent, ctx);
  }

  return json.live;
}

const ctx = initializeContext({
  target: "draft-07",
  processors: allProcessors,
});

const parent: Schema = { _zod: { def: { type: "number" } }, value: 42 };
const child: Schema = { _zod: { def: { type: "string" }, parent }, value: "hello" };

console.log(process(child, ctx));
