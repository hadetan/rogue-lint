export type SchemaDef = {
  type: "string" | "number" | "boolean";
};

export type Schema = {
  _zod: {
    def: SchemaDef;
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

const stringProcessor: Processor = (schema, ctx, json) => {
  json.live = `${ctx.target}:${String(schema.value).toUpperCase()}`;
};

const numberProcessor: Processor = (schema, ctx, json) => {
  json.live = `${ctx.target}:${Number(schema.value).toFixed(0)}`;
};

const booleanProcessor: Processor = (schema, ctx, json) => {
  json.live = `${ctx.target}:${schema.value ? "true" : "false"}`;
};

export const allProcessors: Record<string, Processor> = {
  string: stringProcessor,
  number: numberProcessor,
  boolean: booleanProcessor,
};

export const fallbackProcessors: Record<string, Processor> = {
  boolean: booleanProcessor,
};