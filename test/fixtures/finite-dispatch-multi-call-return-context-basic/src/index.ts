import { initializeContext } from "./context.js";
import { allProcessors, fallbackProcessors, type ProcessContext, type Schema } from "./processors.js";

function process(schema: Schema, ctx: ProcessContext): string {
  const seen = ctx.seen.get(schema);
  if (seen) {
    return "cached";
  }

  ctx.seen.set(schema, { live: true });

  const def = schema._zod.def;
  const json = { live: "" };
  const processor = ctx.processors[def.type];
  processor(schema, ctx, json);
  return json.live;
}

function runLive(schema: Schema): string {
  const ctx = initializeContext({
    target: "draft-07",
    metadata: new Map([["format", "ignored"]]),
    processors: allProcessors,
    override: () => {},
    io: "output",
  });

  return process(schema, ctx);
}

function runFallback(schema: Schema): string {
  const ctx = initializeContext({
    target: "draft-07",
    metadata: new Map([["format", "ignored"]]),
    processors: fallbackProcessors,
    override: () => {},
    io: "output",
  });

  return process(schema, ctx);
}

const liveSchema: Schema = { _zod: { def: { type: "string" } }, value: "hello" };
const fallbackSchema: Schema = { _zod: { def: { type: "boolean" } }, value: true };

console.log(runLive(liveSchema));
console.log(runFallback(fallbackSchema));
