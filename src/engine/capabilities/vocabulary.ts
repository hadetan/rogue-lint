/**
 * Canonical runtime vocabulary for provider-owned capability attribution.
 */

export const ANALYSIS_CAPABILITY_ID = {
  finiteKeyedAccess: "finite-keyed-access",
  returnedStructureTransport: "returned-structure-transport",
  helperTransport: "helper-transport",
  libraryPublicSurfaceAliasing: "library-public-surface-aliasing",
} as const;

export type AnalysisCapabilityId = (typeof ANALYSIS_CAPABILITY_ID)[keyof typeof ANALYSIS_CAPABILITY_ID];

export const ANALYSIS_CAPABILITY_OBLIGATION_FAMILY = {
  internalExportedInterfaceMember: "internal-exported-interface-member",
  returnedContractMember: "returned-contract-member",
} as const;

export type AnalysisCapabilityObligationFamily = (typeof ANALYSIS_CAPABILITY_OBLIGATION_FAMILY)[keyof typeof ANALYSIS_CAPABILITY_OBLIGATION_FAMILY];

export const ANALYSIS_CAPABILITY_OUTCOME = {
  finding: "finding",
  kept: "kept",
  skipped: "skipped",
  live: "live",
  boundary: "boundary",
} as const;

export type AnalysisCapabilityOutcome = (typeof ANALYSIS_CAPABILITY_OUTCOME)[keyof typeof ANALYSIS_CAPABILITY_OUTCOME];

export const ANALYSIS_CAPABILITY_FACT_FAMILY = {
  helperTransport: ANALYSIS_CAPABILITY_ID.helperTransport,
  finiteKeyedAccess: ANALYSIS_CAPABILITY_ID.finiteKeyedAccess,
} as const;

export type AnalysisCapabilityFactFamily = (typeof ANALYSIS_CAPABILITY_FACT_FAMILY)[keyof typeof ANALYSIS_CAPABILITY_FACT_FAMILY];

export const ANALYSIS_CAPABILITY_FACT_OUTCOME = {
  live: "live",
  boundary: "boundary",
} as const;

export type AnalysisCapabilityFactOutcome = (typeof ANALYSIS_CAPABILITY_FACT_OUTCOME)[keyof typeof ANALYSIS_CAPABILITY_FACT_OUTCOME];

export const ANALYSIS_CAPABILITY_EVIDENCE_SOURCE = {
  finding: "finding",
  kept: "kept",
  skipped: "skipped",
  diagnostic: "diagnostic",
  obligation: "obligation",
  fact: "fact",
} as const;

export type AnalysisCapabilityEvidenceSource = (typeof ANALYSIS_CAPABILITY_EVIDENCE_SOURCE)[keyof typeof ANALYSIS_CAPABILITY_EVIDENCE_SOURCE];

export const ANALYSIS_CAPABILITY_BOUNDARY_SOURCE = {
  skipped: "skipped",
  diagnostic: "diagnostic",
  obligation: "obligation",
  boundary: "boundary",
  fact: "fact",
} as const;

export type AnalysisCapabilityBoundarySource = (typeof ANALYSIS_CAPABILITY_BOUNDARY_SOURCE)[keyof typeof ANALYSIS_CAPABILITY_BOUNDARY_SOURCE];

export const ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE = {
  finding: "finding",
  kept: "kept",
  skipped: "skipped",
} as const;

export type AnalysisCapabilityAttributionSource = (typeof ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE)[keyof typeof ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE];

export const ANALYSIS_CAPABILITY_FALLBACK_BOUNDARY_LABEL = {
  [ANALYSIS_CAPABILITY_ID.finiteKeyedAccess]: "finite keyed access summary fallback",
  [ANALYSIS_CAPABILITY_ID.returnedStructureTransport]: "returned transport summary fallback",
  [ANALYSIS_CAPABILITY_ID.helperTransport]: "helper transport summary fallback",
  [ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing]: "public surface aliasing fallback",
} as const satisfies Record<AnalysisCapabilityId, string>;

export const ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_TRANSPORT = "same-project helper transport" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_RETAINED_STORAGE = "same-project helper retained storage" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_ESCAPE = "same-project helper escape" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_RETURNED_STRUCTURE = "same-project helper return summary" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_BOUNDED_FINITE_KEY_READ = "bounded finite key read" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_PROMISE_ALL_TRANSPORT = "Promise.all transport summary" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_CALLBACK_TRANSPORT_BOUNDARY = "callback transport boundary" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_OPAQUE_HELPER_MUTATION_BOUNDARY = "opaque helper mutation boundary" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_OPAQUE_HELPER_TRANSPORT_BOUNDARY = "opaque helper transport boundary" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_ARRAY_AT_BOUNDARY = "array .at boundary" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_COMPUTED_KEY_BOUNDARY = "computed key boundary" as const;
export const ANALYSIS_CAPABILITY_DETAIL_LABEL_DYNAMIC_INDEX_BOUNDARY = "dynamic index boundary" as const;

function observeAnalysisCapabilityVocabularySurface(): void {
  void ANALYSIS_CAPABILITY_ID.finiteKeyedAccess;
  void ANALYSIS_CAPABILITY_ID.returnedStructureTransport;
  void ANALYSIS_CAPABILITY_ID.helperTransport;
  void ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing;

  void ANALYSIS_CAPABILITY_OBLIGATION_FAMILY.internalExportedInterfaceMember;
  void ANALYSIS_CAPABILITY_OBLIGATION_FAMILY.returnedContractMember;

  void ANALYSIS_CAPABILITY_OUTCOME.finding;
  void ANALYSIS_CAPABILITY_OUTCOME.kept;
  void ANALYSIS_CAPABILITY_OUTCOME.skipped;
  void ANALYSIS_CAPABILITY_OUTCOME.live;
  void ANALYSIS_CAPABILITY_OUTCOME.boundary;

  void ANALYSIS_CAPABILITY_FACT_FAMILY.helperTransport;
  void ANALYSIS_CAPABILITY_FACT_FAMILY.finiteKeyedAccess;

  void ANALYSIS_CAPABILITY_FACT_OUTCOME.live;
  void ANALYSIS_CAPABILITY_FACT_OUTCOME.boundary;

  void ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.finding;
  void ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.kept;
  void ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.skipped;
  void ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.diagnostic;
  void ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.obligation;
  void ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.fact;

  void ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.skipped;
  void ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.diagnostic;
  void ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.obligation;
  void ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.boundary;
  void ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.fact;

  void ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.finding;
  void ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.kept;
  void ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.skipped;

  void ANALYSIS_CAPABILITY_FALLBACK_BOUNDARY_LABEL[ANALYSIS_CAPABILITY_ID.finiteKeyedAccess];
  void ANALYSIS_CAPABILITY_FALLBACK_BOUNDARY_LABEL[ANALYSIS_CAPABILITY_ID.returnedStructureTransport];
  void ANALYSIS_CAPABILITY_FALLBACK_BOUNDARY_LABEL[ANALYSIS_CAPABILITY_ID.helperTransport];
  void ANALYSIS_CAPABILITY_FALLBACK_BOUNDARY_LABEL[ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing];

  void ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_TRANSPORT;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_RETAINED_STORAGE;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_ESCAPE;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_RETURNED_STRUCTURE;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_BOUNDED_FINITE_KEY_READ;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_PROMISE_ALL_TRANSPORT;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_CALLBACK_TRANSPORT_BOUNDARY;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_OPAQUE_HELPER_MUTATION_BOUNDARY;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_OPAQUE_HELPER_TRANSPORT_BOUNDARY;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_ARRAY_AT_BOUNDARY;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_COMPUTED_KEY_BOUNDARY;
  void ANALYSIS_CAPABILITY_DETAIL_LABEL_DYNAMIC_INDEX_BOUNDARY;
}

observeAnalysisCapabilityVocabularySurface();
