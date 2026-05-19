import { ENTITY_KIND } from "./entity-vocabulary.js";

/**
 * Canonical runtime vocabulary for exact path segment kinds.
 */
export const PATH_SEGMENT_KIND = {
  property: "property",
  index: "index",
} as const;

/**
 * Canonical runtime vocabulary for tracked exact object node origins.
 */
export const TRACKED_OBJECT_NODE_ORIGIN = {
  property: PATH_SEGMENT_KIND.property,
  method: "method",
  arrayElement: ENTITY_KIND.arrayElement,
} as const;
