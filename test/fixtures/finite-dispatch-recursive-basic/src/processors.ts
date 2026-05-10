export type SchemaDef = {
  type: "string" | "number" | "boolean";
};

export type Schema = {
  _zod: {
    def: SchemaDef;
    parent?: Schema;
  };
  value: string | number | boolean;
};

export type ProcessContext = {
  processors: Record<string, Processor>;
  target: string;
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
