export type Schema = {
  _zod: {
    def: {
      type: "string" | "number";
    };
  };
  value: string | number;
};

export type ProcessContext = {
  processors: Record<string, Processor>;
  target: string;
  metadata: Map<string, string>;
};

export type Processor = (schema: Schema, ctx: ProcessContext, json: { live: string }) => void;

export const allProcessors: Record<string, Processor> = {
  string(schema, ctx, json) {
    json.live = `${ctx.target}:${String(schema.value).toUpperCase()}`;
  },
  number(schema, ctx, json) {
    json.live = `${ctx.target}:${Number(schema.value).toFixed(0)}`;
  },
  regex(schema, ctx, json) {
    json.live = `${ctx.target}:${String(schema.value)}`;
  },
};
