/**
 * Canonical runtime vocabulary for conservative exact-analysis boundary categories.
 */

export const SKIP_CATEGORY = {
  decoratorVisibility: "decorator-visibility",
  computedMemberName: "computed-member-name",
  computedPropertyName: "computed-property-name",
  computedPropertyAccess: "computed-property-access",
  dynamicArrayIndex: "dynamic-array-index",
  arrayAtCall: "array-at-call",
  arrayAppendMutation: "array-append-mutation",
  arrayMutation: "array-mutation",
  arrayTruncateMutation: "array-truncate-mutation",
  arrayReplacementMutation: "array-replacement-mutation",
  arrayReorderMutation: "array-reorder-mutation",
  arrayRebuildMutation: "array-rebuild-mutation",
  arrayOpaqueMutation: "array-opaque-mutation",
  arrayCallbackEscape: "array-callback-escape",
  objectSpread: "object-spread",
  arraySpread: "array-spread",
  returnedObject: "returned-object",
  reflectiveEnumeration: "reflective-enumeration",
  serialization: "serialization",
  opaqueObjectCall: "opaque-object-call",
  spreadEscape: "spread-escape",
  objectRest: "object-rest",
  arrayRest: "array-rest",
} as const;
