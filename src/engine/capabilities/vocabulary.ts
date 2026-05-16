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
  live: ANALYSIS_CAPABILITY_OUTCOME.live,
  boundary: ANALYSIS_CAPABILITY_OUTCOME.boundary,
} as const;

export type AnalysisCapabilityFactOutcome = (typeof ANALYSIS_CAPABILITY_FACT_OUTCOME)[keyof typeof ANALYSIS_CAPABILITY_FACT_OUTCOME];

export const ANALYSIS_CAPABILITY_EVIDENCE_SOURCE = {
  finding: ANALYSIS_CAPABILITY_OUTCOME.finding,
  kept: ANALYSIS_CAPABILITY_OUTCOME.kept,
  skipped: ANALYSIS_CAPABILITY_OUTCOME.skipped,
  diagnostic: "diagnostic",
  obligation: "obligation",
  fact: "fact",
} as const;

export type AnalysisCapabilityEvidenceSource = (typeof ANALYSIS_CAPABILITY_EVIDENCE_SOURCE)[keyof typeof ANALYSIS_CAPABILITY_EVIDENCE_SOURCE];

export const ANALYSIS_CAPABILITY_BOUNDARY_SOURCE = {
  skipped: ANALYSIS_CAPABILITY_OUTCOME.skipped,
  diagnostic: ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.diagnostic,
  obligation: ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.obligation,
  boundary: ANALYSIS_CAPABILITY_OUTCOME.boundary,
  fact: ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.fact,
} as const;

export type AnalysisCapabilityBoundarySource = (typeof ANALYSIS_CAPABILITY_BOUNDARY_SOURCE)[keyof typeof ANALYSIS_CAPABILITY_BOUNDARY_SOURCE];

export const ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE = {
  finding: ANALYSIS_CAPABILITY_OUTCOME.finding,
  kept: ANALYSIS_CAPABILITY_OUTCOME.kept,
  skipped: ANALYSIS_CAPABILITY_OUTCOME.skipped,
} as const;

export type AnalysisCapabilityAttributionSource = (typeof ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE)[keyof typeof ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE];

export const ANALYSIS_CAPABILITY_FALLBACK_BOUNDARY_LABEL = {
  [ANALYSIS_CAPABILITY_ID.finiteKeyedAccess]: "finite keyed access summary fallback",
  [ANALYSIS_CAPABILITY_ID.returnedStructureTransport]: "returned transport summary fallback",
  [ANALYSIS_CAPABILITY_ID.helperTransport]: "helper transport summary fallback",
  [ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing]: "public surface aliasing fallback",
} as const satisfies Record<AnalysisCapabilityId, string>;

export const ANALYSIS_CAPABILITY_DETAIL_LABEL = {
  sameProjectHelperTransport: "same-project helper transport",
  sameProjectHelperRetainedStorage: "same-project helper retained storage",
  sameProjectHelperEscape: "same-project helper escape",
  sameProjectReturnedStructure: "same-project helper return summary",
  boundedFiniteKeyRead: "bounded finite key read",
  promiseAllTransport: "Promise.all transport summary",
  callbackTransportBoundary: "callback transport boundary",
  opaqueHelperMutationBoundary: "opaque helper mutation boundary",
  opaqueHelperTransportBoundary: "opaque helper transport boundary",
  arrayAtBoundary: "array .at boundary",
  computedKeyBoundary: "computed key boundary",
  dynamicIndexBoundary: "dynamic index boundary",
} as const;
