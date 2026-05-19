/**
 * Canonical runtime vocabulary for reportable entity categories.
 */
class EntityKindVocabulary {
  readonly file = "file" as const;
  readonly export = "export" as const;
  readonly import = "import" as const;
  readonly local = "local" as const;
  readonly type = "type" as const;
  readonly enumMember = "enum-member" as const;
  readonly classMember = "class-member" as const;
  readonly arrayElement = "array-element" as const;
  readonly collectionBoundary = "collection-boundary" as const;
  readonly interfaceMember = "interface-member" as const;
  readonly objectKey = "object-key" as const;
  readonly nestedPath = "nested-path" as const;
  readonly assignment = "assignment" as const;
  readonly expression = "expression" as const;
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
