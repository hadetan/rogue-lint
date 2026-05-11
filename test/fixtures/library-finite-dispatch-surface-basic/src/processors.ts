export type SchemaDef = {
  type: "boolean" | "date" | "number" | "string" | "template_literal";
};

export type Schema = {
  _zod: {
    def: SchemaDef;
    parent?: Schema;
  };
  value: boolean | number | string;
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

const dateProcessor: Processor = (_schema, ctx, json) => {
  json.live = `${ctx.target}:date`;
};

const templateLiteralProcessor: Processor = (_schema, ctx, json) => {
  json.live = `${ctx.target}:template`;
};

const unusedProcessor: Processor = (_schema, ctx, json) => {
  json.live = `${ctx.target}:unused`;
};

export const allProcessors: Record<string, Processor> = {
  string: stringProcessor,
  number: numberProcessor,
  boolean: booleanProcessor,
  date: dateProcessor,
  template_literal: templateLiteralProcessor,
  unused: unusedProcessor,
};
