/**
 * Canonical runtime vocabulary for reportable entity categories.
 */
export const ENTITY_KIND = {
  file: "file",
  export: "export",
  import: "import",
  local: "local",
  type: "type",
  enumMember: "enum-member",
  classMember: "class-member",
  arrayElement: "array-element",
  collectionBoundary: "collection-boundary",
  interfaceMember: "interface-member",
  objectKey: "object-key",
  nestedPath: "nested-path",
  assignment: "assignment",
  expression: "expression",
} as const;
