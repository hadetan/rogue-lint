const EXACT_ARRAY_CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
]);

/**
 * Reports whether a collection callback method preserves exact element/index correlation.
 */
export function isExactArrayCallbackMethod(methodName: string): boolean {
  return EXACT_ARRAY_CALLBACK_METHODS.has(methodName);
}

/**
 * Returns the callback parameter slot that receives the current collection value.
 */
export function getSupportedArrayCallbackParamIndex(methodName: string): number | undefined {
  if (!isExactArrayCallbackMethod(methodName)) {
    return undefined;
  }

  return methodName === "reduce" || methodName === "reduceRight" ? 1 : 0;
}

/**
 * Returns the callback parameter slot that receives the current collection index.
 */
export function getSupportedArrayCallbackIndexParamIndex(methodName: string): number | undefined {
  const valueParamIndex = getSupportedArrayCallbackParamIndex(methodName);
  return valueParamIndex === undefined ? undefined : valueParamIndex + 1;
}
