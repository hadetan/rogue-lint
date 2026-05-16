/**
 * Canonical runtime vocabulary for tracking-owned method families and container names.
 */

export const TRACKING_RETURN_SUMMARY_KIND = {
  value: "value",
  structured: "structured",
  returnedAlias: "returned-alias",
  opaque: "opaque",
} as const;

export const TRACKING_COLLECTION_KIND = {
  object: "object",
  array: "array",
} as const;

export const TRACKING_ACCESS_KIND = {
  write: "write",
  read: "read",
  readWrite: "read-write",
  escape: "escape",
} as const;

export const TRACKING_HELPER_PARAMETER_EFFECT_KIND = {
  read: TRACKING_ACCESS_KIND.read,
  mutation: "mutation",
  returnedAlias: TRACKING_RETURN_SUMMARY_KIND.returnedAlias,
  retainedBinding: "retained-binding",
  opaqueEscape: "opaque-escape",
} as const;

export const TRACKING_VALUE_FATE = {
  observed: "observed",
  insertedByReference: "inserted-by-reference",
  shallowCloned: "shallow-cloned",
  deepCloned: "deep-cloned",
  resourceTransferred: "resource-transferred",
  escapedOpaquely: "escaped-opaquely",
  overwritten: "overwritten",
  invalidated: "invalidated",
} as const;

export const TRACKING_PLACE_STATE = {
  uninitialized: "uninitialized",
  initialized: "initialized",
  invalidated: TRACKING_VALUE_FATE.invalidated,
  escaped: "escaped",
  unknown: "unknown",
} as const;

export const TRACKING_METHOD_NAME = {
  at: "at",
  copyWithin: "copyWithin",
  entries: "entries",
  every: "every",
  fill: "fill",
  filter: "filter",
  find: "find",
  findIndex: "findIndex",
  findLast: "findLast",
  findLastIndex: "findLastIndex",
  flatMap: "flatMap",
  forEach: "forEach",
  get: "get",
  has: "has",
  includes: "includes",
  indexOf: "indexOf",
  join: "join",
  keys: "keys",
  lastIndexOf: "lastIndexOf",
  map: "map",
  pop: "pop",
  push: "push",
  reduce: "reduce",
  reduceRight: "reduceRight",
  reverse: "reverse",
  set: "set",
  shift: "shift",
  slice: "slice",
  some: "some",
  sort: "sort",
  splice: "splice",
  unshift: "unshift",
  values: "values",
  with: "with",
} as const;

export type TrackingAppendMethodName = typeof TRACKING_METHOD_NAME.push | typeof TRACKING_METHOD_NAME.unshift;

type ExactArrayCallbackMethod =
  | typeof TRACKING_METHOD_NAME.every
  | typeof TRACKING_METHOD_NAME.filter
  | typeof TRACKING_METHOD_NAME.find
  | typeof TRACKING_METHOD_NAME.findIndex
  | typeof TRACKING_METHOD_NAME.findLast
  | typeof TRACKING_METHOD_NAME.findLastIndex
  | typeof TRACKING_METHOD_NAME.flatMap
  | typeof TRACKING_METHOD_NAME.forEach
  | typeof TRACKING_METHOD_NAME.map
  | typeof TRACKING_METHOD_NAME.reduce
  | typeof TRACKING_METHOD_NAME.reduceRight
  | typeof TRACKING_METHOD_NAME.some;

const EXACT_ARRAY_CALLBACK_METHODS = new Set<ExactArrayCallbackMethod>([
  TRACKING_METHOD_NAME.every,
  TRACKING_METHOD_NAME.filter,
  TRACKING_METHOD_NAME.find,
  TRACKING_METHOD_NAME.findIndex,
  TRACKING_METHOD_NAME.findLast,
  TRACKING_METHOD_NAME.findLastIndex,
  TRACKING_METHOD_NAME.flatMap,
  TRACKING_METHOD_NAME.forEach,
  TRACKING_METHOD_NAME.map,
  TRACKING_METHOD_NAME.reduce,
  TRACKING_METHOD_NAME.reduceRight,
  TRACKING_METHOD_NAME.some,
]);

export function isExactArrayCallbackMethod(methodName: string): boolean {
  return EXACT_ARRAY_CALLBACK_METHODS.has(methodName as ExactArrayCallbackMethod);
}

export function getSupportedArrayCallbackParamIndex(methodName: string): number | undefined {
  if (!isExactArrayCallbackMethod(methodName)) {
    return undefined;
  }

  return methodName === TRACKING_METHOD_NAME.reduce || methodName === TRACKING_METHOD_NAME.reduceRight ? 1 : 0;
}

export function getSupportedArrayCallbackIndexParamIndex(methodName: string): number | undefined {
  const valueParamIndex = getSupportedArrayCallbackParamIndex(methodName);
  return valueParamIndex === undefined ? undefined : valueParamIndex + 1;
}

export const WHOLE_ARRAY_CONSUMPTION_METHODS = new Set<string>([
  TRACKING_METHOD_NAME.entries,
  TRACKING_METHOD_NAME.includes,
  TRACKING_METHOD_NAME.indexOf,
  TRACKING_METHOD_NAME.join,
  TRACKING_METHOD_NAME.keys,
  TRACKING_METHOD_NAME.lastIndexOf,
  TRACKING_METHOD_NAME.slice,
  TRACKING_METHOD_NAME.with,
  TRACKING_METHOD_NAME.values,
]);

export const ARRAY_APPEND_METHODS = new Set<string>([
  TRACKING_METHOD_NAME.push,
]);

export const ARRAY_TRUNCATE_METHODS = new Set<string>([
  TRACKING_METHOD_NAME.pop,
]);

export const ARRAY_REPLACEMENT_METHODS = new Set<string>([
  TRACKING_METHOD_NAME.fill,
]);

export const ARRAY_REORDER_METHODS = new Set<string>([
  TRACKING_METHOD_NAME.copyWithin,
  TRACKING_METHOD_NAME.reverse,
  TRACKING_METHOD_NAME.shift,
  TRACKING_METHOD_NAME.sort,
  TRACKING_METHOD_NAME.splice,
  TRACKING_METHOD_NAME.unshift,
]);

export const TRACKING_ARRAY_EXACT_APPEND_METHODS = new Set<string>([
  TRACKING_METHOD_NAME.push,
  TRACKING_METHOD_NAME.unshift,
]);

export const TRACKING_ARRAY_END_REMOVAL_METHODS = new Set<string>([
  TRACKING_METHOD_NAME.pop,
  TRACKING_METHOD_NAME.shift,
]);

export const TRACKING_ARRAY_INDEX_ACCESS_METHOD = TRACKING_METHOD_NAME.at;
export const TRACKING_RETAINED_BINDING_READ_METHOD = TRACKING_METHOD_NAME.get;
export const TRACKING_RETAINED_BINDING_WRITE_METHOD = TRACKING_METHOD_NAME.set;

export const TRACKING_RETAINED_BINDING_OBSERVER_METHODS = new Set<string>([
  TRACKING_METHOD_NAME.get,
  TRACKING_METHOD_NAME.has,
  TRACKING_METHOD_NAME.entries,
  TRACKING_METHOD_NAME.keys,
  TRACKING_METHOD_NAME.values,
]);

export const TRACKING_CONTAINER_TYPE_NAME = {
  map: "Map",
  set: "Set",
  weakMap: "WeakMap",
  weakSet: "WeakSet",
} as const;

export const TRACKING_PURE_OBJECT_CONSTRUCTOR_TYPE_NAMES = new Set<string>([
  TRACKING_CONTAINER_TYPE_NAME.map,
  TRACKING_CONTAINER_TYPE_NAME.set,
  TRACKING_CONTAINER_TYPE_NAME.weakMap,
  TRACKING_CONTAINER_TYPE_NAME.weakSet,
]);

export const TRACKING_RETAINED_BINDING_CONTAINER_TYPE_NAMES = new Set<string>([
  TRACKING_CONTAINER_TYPE_NAME.map,
  TRACKING_CONTAINER_TYPE_NAME.weakMap,
]);
