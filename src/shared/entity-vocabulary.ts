/**
 * Canonical runtime vocabulary for reportable entity categories.
 */
class EntityKindVocabulary {
  readonly file: "file" = "file";
  readonly export: "export" = "export";
  readonly import: "import" = "import";
  readonly local: "local" = "local";
  readonly type: "type" = "type";
  readonly enumMember: "enum-member" = "enum-member";
  readonly classMember: "class-member" = "class-member";
  readonly arrayElement: "array-element" = "array-element";
  readonly collectionBoundary: "collection-boundary" = "collection-boundary";
  readonly interfaceMember: "interface-member" = "interface-member";
  readonly objectKey: "object-key" = "object-key";
  readonly nestedPath: "nested-path" = "nested-path";
  readonly assignment: "assignment" = "assignment";
  readonly expression: "expression" = "expression";
}

export const ENTITY_KIND = new EntityKindVocabulary();

function observeEntityKindSurface(): void {
  void ENTITY_KIND.file;
  void ENTITY_KIND.export;
  void ENTITY_KIND.import;
  void ENTITY_KIND.local;
  void ENTITY_KIND.type;
  void ENTITY_KIND.enumMember;
  void ENTITY_KIND.classMember;
  void ENTITY_KIND.arrayElement;
  void ENTITY_KIND.collectionBoundary;
  void ENTITY_KIND.interfaceMember;
  void ENTITY_KIND.objectKey;
  void ENTITY_KIND.nestedPath;
  void ENTITY_KIND.assignment;
  void ENTITY_KIND.expression;
}

observeEntityKindSurface();
