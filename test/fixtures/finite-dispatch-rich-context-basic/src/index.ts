import { initializeContext } from "./context.js";
import { allProcessors, type ProcessContext, type Schema } from "./processors.js";

function process(schema: Schema, ctx: ProcessContext): string {
  const seen = ctx.seen.get(schema);
  if (seen) {
    return "cached";
  }

  ctx.seen.set(schema, { live: true });

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

function run(schema: Schema): string {
  const ctx = initializeContext({
    target: "draft-07",
    metadata: new Map([["format", "ignored"]]),
    processors: allProcessors,
    override: () => {},
    io: "output",
  });

  return process(schema, ctx);
}

const parent: Schema = { _zod: { def: { type: "number" } }, value: 42 };
const child: Schema = { _zod: { def: { type: "string" }, parent }, value: "hello" };

console.log(run(child));
