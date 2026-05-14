import type { ProcessContext, Processor } from "./processors.js";

type ContextParams = {
  processors: Record<string, Processor>;
  target?: string;
};

export function initializeContext(params: ContextParams): ProcessContext {
  return {
    processors: params.processors ?? {},
    target: params.target ?? "draft-2020-12",
  };
}
