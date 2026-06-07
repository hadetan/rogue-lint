import type ts from "typescript";

import type { EntityRecord, ProjectContext, SuppressionContext } from "../../types.js";
import { getSuppressionAudit } from "../../suppressions.js";
import { addAudit, type AnalysisState } from "../analysis-state.js";
import { buildPublicSurfaceAudit } from "./support.js";

/**
 * Options accepted by the preservation gate.
 *
 * Every field is optional so the same helper serves analyzers that care about the public surface and those that
 * only need suppression-rule evaluation.
 */
interface PreservationGateOptions {
  /**
   * When provided, the gate first checks whether `entity.id` is part of the configured public surface and, if so,
   * builds and pushes a public-surface kept audit. Pass `undefined` (or omit) for analyzers that do not participate
   * in public-surface preservation.
   */
  publicSurfaceIds?: ReadonlySet<string>;

  /**
   * Forces the gate to treat the entity as on the public surface without consulting `publicSurfaceIds`. Used by
   * analyzers whose containing declaration is public but whose members are not individually enumerated in the
   * surface set (interface members of a public interface, for example).
   */
  forcePublicSurface?: boolean;

  /**
   * Optional declaration node forwarded to `getSuppressionAudit` for inline-directive and JSDoc lookups. When the
   * caller has a different node than `entity.location` (e.g., the surrounding statement rather than the name node),
   * supply it here.
   */
  declarationNode?: ts.Node;

  /**
   * Invoked when the gate decided the entity is preserved. Lets callers update side state such as capability
   * obligation outcomes without recomputing the decision.
   */
  onKept?: () => void;
}

/**
 * Centralizes the uniform "is this entity preserved?" first-pass that every analyzer used to repeat:
 *
 * 1. If `publicSurfaceIds` is supplied and `entity.id` is on it, build and push a public-surface kept audit.
 * 2. Otherwise, ask `getSuppressionAudit` whether an inline directive, JSDoc tag, or `keep.*` rule applies and push
 *    that audit when present.
 *
 * Analyzer-specific boundary logic (decorators, computed-name detection, escaped-value handling, etc.) stays in
 * the calling analyzer — this gate owns only the preservation pre-check.
 *
 * Returns `true` when the entity is preserved and the caller should stop processing it; otherwise `false`.
 */
export function isPreserved(
  project: ProjectContext,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  entity: EntityRecord,
  options: PreservationGateOptions = {},
): boolean {
  const publicSurfaceAudit = options.forcePublicSurface || options.publicSurfaceIds?.has(entity.id)
    ? buildPublicSurfaceAudit(entity)
    : undefined;
  const audit = publicSurfaceAudit
    ?? getSuppressionAudit(project, suppressionContext, entity, options.declarationNode);

  if (!addAudit(state.kept, audit)) {
    return false;
  }

  options.onKept?.();
  return true;
}
