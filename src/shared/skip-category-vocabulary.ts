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

function observeSkipCategorySurface(): void {
  void SKIP_CATEGORY.decoratorVisibility;
  void SKIP_CATEGORY.computedMemberName;
  void SKIP_CATEGORY.computedPropertyName;
  void SKIP_CATEGORY.computedPropertyAccess;
  void SKIP_CATEGORY.dynamicArrayIndex;
  void SKIP_CATEGORY.arrayAtCall;
  void SKIP_CATEGORY.arrayAppendMutation;
  void SKIP_CATEGORY.arrayMutation;
  void SKIP_CATEGORY.arrayTruncateMutation;
  void SKIP_CATEGORY.arrayReplacementMutation;
  void SKIP_CATEGORY.arrayReorderMutation;
  void SKIP_CATEGORY.arrayRebuildMutation;
  void SKIP_CATEGORY.arrayOpaqueMutation;
  void SKIP_CATEGORY.arrayCallbackEscape;
  void SKIP_CATEGORY.objectSpread;
  void SKIP_CATEGORY.arraySpread;
  void SKIP_CATEGORY.returnedObject;
  void SKIP_CATEGORY.reflectiveEnumeration;
  void SKIP_CATEGORY.serialization;
  void SKIP_CATEGORY.opaqueObjectCall;
  void SKIP_CATEGORY.spreadEscape;
  void SKIP_CATEGORY.objectRest;
  void SKIP_CATEGORY.arrayRest;
}

observeSkipCategorySurface();
