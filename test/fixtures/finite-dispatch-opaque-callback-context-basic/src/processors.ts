export type ProcessJSONSchema = (
  ctx: ProcessContext,
  json: { live: string },
  params: { path: (string | number)[] },
) => void;

export type SchemaDef = {
  type: "string" | "number" | "boolean";
};

export type Schema = {
  _zod: {
    def: SchemaDef;
    parent?: Schema;
    processJSONSchema?: ProcessJSONSchema | undefined;
  };
  value: string | number | boolean;
};

export type ProcessContext = {
  processors: Record<string, Processor>;
  metadataRegistry: Map<string, string>;
  target: string;
  override: () => void;
  io: "input" | "output";
  counter: number;
  seen: Map<Schema, { live: boolean }>;
};

export type Processor = (schema: Schema, ctx: ProcessContext, json: { live: string }) => void;

export const allProcessors: Record<string, Processor> = {
  string(schema, ctx, json) {
    json.live = `${ctx.target}:${String(schema.value).toUpperCase()}`;
  },
  number(schema, ctx, json) {
    json.live = `${ctx.target}:${Number(schema.value).toFixed(0)}`;
  },
  boolean(schema, ctx, json) {
    json.live = `${ctx.target}:${schema.value ? "true" : "false"}`;
  },
};
