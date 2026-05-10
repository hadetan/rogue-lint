import type { ProcessContext, Processor } from "./processors.js";

type ContextParams = {
  processors: Record<string, Processor>;
  target?: string;
  metadata?: Map<string, string>;
  override?: (() => void) | undefined;
  io?: "input" | "output";
  external?: { defs: Record<string, unknown> } | undefined;
};

export function initializeContext(params: ContextParams): ProcessContext {
  return {
    processors: params.processors ?? {},
    metadataRegistry: params.metadata ?? new Map(),
    target: params.target ?? "draft-2020-12",
    override: params.override ?? (() => {}),
    io: params.io ?? "output",
    counter: 0,
    seen: new Map(),
    external: params.external ?? undefined,
  };
}
