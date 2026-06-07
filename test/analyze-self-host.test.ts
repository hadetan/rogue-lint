import { describe, expect, it } from "vitest";

import { getAnalysisCapabilityLedger } from "../src/engine/capabilities/providers.js";
import { analyzeProject } from "../src/index.js";

function normalizeAudit(entry: { category?: string; kind: string; name: string; location?: { file: string; line: number } }): string {
  return `${entry.category ?? "-"}:${entry.kind}:${entry.location?.file ?? "-"}:${entry.location?.line ?? 0}:${entry.name}`;
}

function normalizeFinding(entry: { kind: string; entity: { name: string; location?: { file: string; line: number } } }): string {
  return `-:${entry.kind}:${entry.entity.location?.file ?? "-"}:${entry.entity.location?.line ?? 0}:${entry.entity.name}`;
}

function getCapabilityCoverageGapDiagnostics(result: { diagnostics: Array<{ message: string }> }): Array<{ message: string }> {
  return result.diagnostics.filter((diagnostic) => diagnostic.message.includes("capability coverage gap"));
}

const EXPECTED_SELF_HOST_FINDINGS: string[] = [];
const EXPECTED_SELF_HOST_SKIPS: string[] = [
  "computed-property-access:collection-boundary:src/engine/tracking/object-paths/visitor.ts:1880:resolveBoundedHelperCallables()",
  "external-container-store:object-key:src/engine/tracking/access.ts:1079:id",
  "external-container-store:object-key:src/engine/tracking/access.ts:1080:derivedStateRevision",
  "external-container-store:object-key:src/engine/tracking/access.ts:1081:canonicalSymbolKey",
  "external-container-store:object-key:src/engine/tracking/access.ts:1082:rootName",
  "external-container-store:object-key:src/engine/tracking/access.ts:1083:sourceFile",
  "external-container-store:object-key:src/engine/tracking/access.ts:1084:rootEntity",
  "external-container-store:object-key:src/engine/tracking/access.ts:1085:nodes",
  "external-container-store:object-key:src/engine/tracking/access.ts:1086:callablePaths",
  "external-container-store:object-key:src/engine/tracking/access.ts:1087:descendantNodeKeys",
  "external-container-store:object-key:src/engine/tracking/access.ts:1088:collections",
  "external-container-store:object-key:src/engine/tracking/access.ts:1089:collectionStates",
  "external-container-store:object-key:src/engine/tracking/access.ts:1090:collectionBoundaries",
  "external-container-store:object-key:src/engine/tracking/access.ts:1091:invalidatedCollectionPaths",
  "external-container-store:object-key:src/engine/tracking/access.ts:1092:invalidatedPaths",
  "external-container-store:object-key:src/engine/tracking/access.ts:1093:placeStates",
  "external-container-store:object-key:src/engine/tracking/access.ts:1094:observedSubtrees",
  "external-container-store:object-key:src/engine/tracking/access.ts:1095:escapedPaths",
  "external-container-store:object-key:src/engine/tracking/access.ts:1096:exactPathAliases",
  "external-container-store:object-key:src/engine/tracking/access.ts:1097:valueFates",
  "external-container-store:object-key:src/engine/tracking/access.ts:1098:reads",
  "external-container-store:object-key:src/engine/tracking/access.ts:1099:writes",
  "external-container-store:object-key:src/engine/tracking/access.ts:415:id",
  "external-container-store:object-key:src/engine/tracking/access.ts:416:derivedStateRevision",
  "external-container-store:object-key:src/engine/tracking/access.ts:417:canonicalSymbolKey",
  "external-container-store:object-key:src/engine/tracking/access.ts:418:rootName",
  "external-container-store:object-key:src/engine/tracking/access.ts:419:sourceFile",
  "external-container-store:object-key:src/engine/tracking/access.ts:420:rootEntity",
  "external-container-store:object-key:src/engine/tracking/access.ts:421:nodes",
  "external-container-store:object-key:src/engine/tracking/access.ts:422:callablePaths",
  "external-container-store:object-key:src/engine/tracking/access.ts:423:descendantNodeKeys",
  "external-container-store:object-key:src/engine/tracking/access.ts:424:collections",
  "external-container-store:object-key:src/engine/tracking/access.ts:425:collectionStates",
  "external-container-store:object-key:src/engine/tracking/access.ts:426:collectionBoundaries",
  "external-container-store:object-key:src/engine/tracking/access.ts:427:invalidatedCollectionPaths",
  "external-container-store:object-key:src/engine/tracking/access.ts:428:invalidatedPaths",
  "external-container-store:object-key:src/engine/tracking/access.ts:429:placeStates",
  "external-container-store:object-key:src/engine/tracking/access.ts:430:observedSubtrees",
  "external-container-store:object-key:src/engine/tracking/access.ts:431:escapedPaths",
  "external-container-store:object-key:src/engine/tracking/access.ts:432:exactPathAliases",
  "external-container-store:object-key:src/engine/tracking/access.ts:433:valueFates",
  "external-container-store:object-key:src/engine/tracking/access.ts:434:reads",
  "external-container-store:object-key:src/engine/tracking/access.ts:435:writes",
  "external-container-store:object-key:src/engine/tracking/graph.ts:425:id",
  "external-container-store:object-key:src/engine/tracking/graph.ts:426:derivedStateRevision",
  "external-container-store:object-key:src/engine/tracking/graph.ts:427:canonicalSymbolKey",
  "external-container-store:object-key:src/engine/tracking/graph.ts:428:rootName",
  "external-container-store:object-key:src/engine/tracking/graph.ts:429:sourceFile",
  "external-container-store:object-key:src/engine/tracking/graph.ts:430:rootEntity",
  "external-container-store:object-key:src/engine/tracking/graph.ts:431:structuralRole",
  "external-container-store:object-key:src/engine/tracking/graph.ts:432:nodes",
  "external-container-store:object-key:src/engine/tracking/graph.ts:433:callablePaths",
  "external-container-store:object-key:src/engine/tracking/graph.ts:434:descendantNodeKeys",
  "external-container-store:object-key:src/engine/tracking/graph.ts:435:collections",
  "external-container-store:object-key:src/engine/tracking/graph.ts:436:collectionStates",
  "external-container-store:object-key:src/engine/tracking/graph.ts:437:collectionBoundaries",
  "external-container-store:object-key:src/engine/tracking/graph.ts:438:invalidatedCollectionPaths",
  "external-container-store:object-key:src/engine/tracking/graph.ts:439:invalidatedPaths",
  "external-container-store:object-key:src/engine/tracking/graph.ts:440:placeStates",
  "external-container-store:object-key:src/engine/tracking/graph.ts:441:observedSubtrees",
  "external-container-store:object-key:src/engine/tracking/graph.ts:442:escapedPaths",
  "external-container-store:object-key:src/engine/tracking/graph.ts:443:exactPathAliases",
  "external-container-store:object-key:src/engine/tracking/graph.ts:444:valueFates",
  "external-container-store:object-key:src/engine/tracking/graph.ts:445:reads",
  "external-container-store:object-key:src/engine/tracking/graph.ts:446:writes",
  "external-container-store:object-key:src/engine/tracking/vocabulary.ts:45:initialized",
  "helper-call-boundary:array-element:src/engine/tracking/access.ts:1387:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/access.ts:1506:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/access.ts:1557:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/access.ts:1653:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/access.ts:1702:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/access.ts:1881:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/access.ts:1898:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/access.ts:583:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/access.ts:591:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/carriers.ts:79:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/carriers.ts:79:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/literal-materialization.ts:274:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/literal-materialization.ts:324:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/literal-materialization.ts:483:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/collection-operations.ts:116:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/finite-lookups.ts:126:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/finite-lookups.ts:133:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/finite-lookups.ts:67:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/overlay.ts:224:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/overlay.ts:259:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/projection-traversal.ts:100:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/projections.ts:103:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/projections.ts:40:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/visitor.ts:1720:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/object-paths/visitor.ts:380:[0]",
  "helper-call-boundary:array-element:src/engine/tracking/semantics.ts:564:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/semantics.ts:625:[1]",
  "helper-call-boundary:array-element:src/engine/tracking/semantics.ts:690:[0]",
  "helper-call-boundary:nested-path:src/engine/tracking/object-paths/projections.ts:103:[0].kind",
  "helper-call-boundary:nested-path:src/engine/tracking/object-paths/projections.ts:103:[0].value",
  "helper-call-boundary:object-key:src/engine/capabilities/providers.ts:100:file",
  "helper-call-boundary:object-key:src/engine/capabilities/providers.ts:101:message",
  "helper-call-boundary:object-key:src/engine/capabilities/providers.ts:99:kind",
  "helper-call-boundary:object-key:src/engine/tracking/literal-materialization.ts:437:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/literal-materialization.ts:438:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/collection-operations.ts:137:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/collection-operations.ts:137:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/collection-operations.ts:137:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/collection-operations.ts:137:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/effects.ts:68:entity",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/effects.ts:69:path",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/effects.ts:70:category",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/effects.ts:71:reason",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:598:kind",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:599:statement",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:600:relativeCollectionPath",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:601:elementSymbolKey",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:607:kind",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:608:call",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:609:sourceFile",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:610:methodName",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:611:relativeCollectionPath",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/helper-plans.ts:612:slotPlans",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projection-traversal.ts:157:elementBindings",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projection-traversal.ts:158:receiverBindings",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projection-traversal.ts:159:indexBindings",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projection-traversal.ts:202:elementBindings",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projection-traversal.ts:203:receiverBindings",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projection-traversal.ts:204:indexBindings",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:100:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:101:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:107:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:107:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:281:elementBindings",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:282:receiverBindings",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:283:indexBindings",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:62:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:62:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:63:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/projections.ts:63:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/visitor.ts:155:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/visitor.ts:155:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/visitor.ts:159:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/object-paths/visitor.ts:159:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/semantics.ts:1737:parameterMeaningfulUse",
  "helper-call-boundary:object-key:src/engine/tracking/semantics.ts:1738:callablePurity",
  "helper-call-boundary:object-key:src/engine/tracking/semantics.ts:557:trackedObject",
  "helper-call-boundary:object-key:src/engine/tracking/semantics.ts:558:prefix",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:127:entity",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:128:position",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:129:kind",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:130:mayObservePreviousValue",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:131:nestedWrite",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:132:controlFlowDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:133:functionDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:134:flowSignature",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:147:entity",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:148:position",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:149:kind",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:150:mayObservePreviousValue",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:153:nestedWrite",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:154:controlFlowDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:155:functionDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:156:flowSignature",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:172:entity",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:173:position",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:174:kind",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:175:mayObservePreviousValue",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:176:nestedWrite",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:177:controlFlowDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:178:functionDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:179:flowSignature",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:227:entity",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:228:position",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:229:kind",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:230:mayObservePreviousValue",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:231:nestedWrite",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:232:controlFlowDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:233:functionDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:234:flowSignature",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:244:entity",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:245:position",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:246:kind",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:247:mayObservePreviousValue",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:248:nestedWrite",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:249:controlFlowDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:250:functionDepth",
  "helper-call-boundary:object-key:src/engine/tracking/value-liveness.ts:251:flowSignature",
  "object-spread:object-key:src/config.ts:77:mode",
  "object-spread:object-key:src/config.ts:82:keep",
  "object-spread:object-key:src/config.ts:86:objectAnalysis",
  "object-spread:object-key:src/config.ts:90:internalNamespaceMethodCarriers",
  "opaque-object-call:object-key:src/config.ts:78:includeKinds",
  "opaque-object-call:object-key:src/engine/analyzers/compiler-safety.ts:113:declarationNode",
  "opaque-object-call:object-key:src/engine/tracking/callables.ts:723:declaration",
  "opaque-object-call:object-key:src/engine/tracking/callables.ts:724:symbolKey",
  "opaque-object-call:object-key:src/engine/tracking/object-paths/helper-transport.ts:265:specializedBindings",
  "opaque-object-call:object-key:src/engine/tracking/semantics.ts:1653:projectionContext",
  "opaque-object-call:object-key:src/engine/tracking/state.ts:57:fate",
  "opaque-object-call:object-key:src/engine/tracking/state.ts:58:path",
  "opaque-object-call:object-key:src/engine/tracking/state.ts:59:reason",
  "opaque-object-call:object-key:src/engine/tracking/state.ts:60:relatedObjectId",
  "opaque-object-call:object-key:src/engine/tracking/state.ts:61:relatedPath",
  "opaque-object-call:object-key:src/shared/skip-category-vocabulary.ts:29:externalContainerStore",
  "returned-object:array-element:src/benchmark/manifests.ts:270:[0]",
  "returned-object:array-element:src/benchmark/manifests.ts:275:[1]",
  "returned-object:array-element:src/engine/tracking/graph.ts:318:[0]",
  "returned-object:array-element:src/engine/tracking/graph.ts:370:[1]",
  "returned-object:nested-path:src/engine/tracking/convergence.ts:416:widening.bindingChanges",
  "returned-object:nested-path:src/engine/tracking/convergence.ts:417:widening.returnSummaryChanges",
  "returned-object:object-key:src/engine/tracking/callables.ts:700:declaration",
  "returned-object:object-key:src/engine/tracking/callables.ts:701:symbolKey",
  "returned-object:object-key:src/engine/tracking/convergence.ts:409:passes",
  "returned-object:object-key:src/engine/tracking/convergence.ts:410:warningPassThreshold",
  "returned-object:object-key:src/engine/tracking/convergence.ts:411:maxPasses",
  "returned-object:object-key:src/engine/tracking/convergence.ts:412:warned",
  "returned-object:object-key:src/engine/tracking/convergence.ts:413:elapsedMs",
  "returned-object:object-key:src/engine/tracking/convergence.ts:414:churn",
  "returned-object:object-key:src/engine/tracking/convergence.ts:415:widening",
  "returned-object:object-key:src/engine/tracking/convergence.ts:419:unstableSamples",
  "returned-object:object-key:src/engine/tracking/convergence.ts:420:debugTrace",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:181:sourceFile",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:182:projectionBindings",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:183:projectionReceiverBindings",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:184:projectionIndexBindings",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:185:finiteLookupBindings",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:186:helperFiniteReturnCache",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:187:handledExactCallbackBodies",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:188:retainedContainerConflicts",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:189:handledSpreadAppendStarts",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:190:parameterMeaningfulUse",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:191:parameterSummaryCache",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:192:helperExecutionSnapshotCache",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:193:helperExactAppendPlanCache",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:194:helperProjectedUsagePlanCache",
  "returned-object:object-key:src/engine/tracking/object-paths/stage-context.ts:195:higherOrderCallableReturnSummaryCache",
  "returned-object:object-key:src/engine/tracking/object-paths/visitor.ts:853:known",
  "returned-object:object-key:src/engine/tracking/semantics.ts:485:boundaryReason",
  "returned-object:object-key:src/engine/tracking/semantics.ts:545:boundaryReason",
];
const SELF_HOST_TIMEOUT_MS = 90000;

let selfHostLibraryResultPromise: ReturnType<typeof analyzeProject> | undefined;

function getSelfHostLibraryResult() {
  selfHostLibraryResultPromise ??= analyzeProject({
    cwd: process.cwd(),
    targetPath: process.cwd(),
    format: "json",
    mode: "library",
  });

  return selfHostLibraryResultPromise;
}

describe("rogue-lint self-host analyzer", () => {
  it("does not surface helper bookkeeping residuals during self-host analysis", async () => {
    const result = await getSelfHostLibraryResult();

    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element"
      && finding.entity.location.file === "src/engine/tracking/object-paths/visitor.ts"
      && [120, 637].includes(finding.entity.location.line)
      && finding.entity.name === "[0]"
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element"
      && finding.entity.location.file === "src/engine/tracking/semantics.ts"
      && finding.entity.location.line === 193
      && finding.entity.name === "[0]"
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.location.file === "src/benchmark/run-benchmark.ts"
      && finding.entity.location.line === 104
      && finding.entity.name === "format"
    )).toBe(false);
    expect(result.skipped.some((entry) =>
      entry.category === "array-callback-escape"
      && entry.location?.file === "src/engine/tracking/semantics.ts"
      && entry.location.line === 834
      && entry.name === "getExactHelperReadPaths()"
    )).toBe(false);
    expect(result.skipped.some((entry) =>
      entry.category === "returned-object"
      && ((entry.location?.file === "src/engine/tracking/graph.ts" && entry.location.line === 269)
        || (entry.location?.file === "src/engine/tracking/semantics.ts" && entry.location.line === 198))
      && entry.name === "[0]"
    )).toBe(false);
  }, SELF_HOST_TIMEOUT_MS);

  it("keeps the self-host surface clean while preserving bounded tracking analysis", async () => {
    const result = await getSelfHostLibraryResult();

    expect(result.diagnostics).toHaveLength(0);
    expect(getCapabilityCoverageGapDiagnostics(result)).toHaveLength(0);
    expect(result.summary.findings).toBe(EXPECTED_SELF_HOST_FINDINGS.length);
    expect(result.summary.skipped).toBe(EXPECTED_SELF_HOST_SKIPS.length);
    expect(result.summary.reachableFiles).toBe(result.summary.filesAnalyzed);
    expect(result.findings.map(normalizeFinding).sort()).toEqual(EXPECTED_SELF_HOST_FINDINGS);
    expect(result.skipped.map(normalizeAudit).sort()).toEqual(EXPECTED_SELF_HOST_SKIPS);
  }, SELF_HOST_TIMEOUT_MS);

  it("keeps helper and finite capability boundary debt out of the normalized self-host surface", async () => {
    const result = await getSelfHostLibraryResult();
    const ledger = getAnalysisCapabilityLedger(result);

    expect(
      ledger?.boundaries.filter((entry) =>
        entry.capabilityId === "helper-transport" || entry.capabilityId === "finite-keyed-access"
      ) ?? [],
    ).toHaveLength(13);
    expect(
      ledger?.attributions.filter((entry) =>
        entry.capabilityId === "helper-transport" || entry.capabilityId === "finite-keyed-access"
      ) ?? [],
    ).toHaveLength(13);
  }, SELF_HOST_TIMEOUT_MS);
});
