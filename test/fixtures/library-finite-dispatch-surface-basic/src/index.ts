import { initializeContext } from "./context.js";
import { allProcessors, type ProcessContext, type Schema } from "./processors.js";

type ToJSONSchemaParams = {
  target?: string;
  metadata?: Map<string, string>;
  override?: (() => void) | undefined;
  io?: "input" | "output";
};

function process(schema: Schema, ctx: ProcessContext): string {
  const getSeen = (candidate: Schema) => ctx.seen.get(candidate);
  const seen = getSeen(schema);
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

export function toJSONSchema(schema: Schema, params?: ToJSONSchemaParams): string {
  const ctx = initializeContext({
    ...params,
    processors: allProcessors,
  });

  return process(schema, ctx);
}

const parent: Schema = { _zod: { def: { type: "number" } }, value: 42 };
const child: Schema = { _zod: { def: { type: "string" }, parent }, value: "hello" };

console.log(toJSONSchema(child, {
  target: "draft-07",
  metadata: new Map([["format", "ignored"]]),
  override: () => {},
  io: "output",
}));
