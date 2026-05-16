import type {
  PathSegment,
} from "../../types.js";
import { PATH_SEGMENT_KIND } from "../../shared/path-vocabulary.js";
import type { TrackedObjectBinding } from "./model.js";
import { getCollectionInfo } from "./state.js";
import { TRACKING_COLLECTION_KIND } from "./vocabulary.js";

/**
 * Returns the exact property segments that remain visible through a resolved object spread binding.
 */
export function visitResolvedSpreadPropertySegments(
  binding: TrackedObjectBinding,
  visit: (segment: PathSegment) => void,
): boolean {
  const collection = getCollectionInfo(binding.trackedObject, binding.prefix);
  if (!collection || collection.kind !== TRACKING_COLLECTION_KIND.object) {
    return false;
  }

  const seen = new Set<string>();
  let visited = false;

  for (const childPath of collection.childPaths) {
    if (childPath.length !== binding.prefix.length + 1) {
      continue;
    }

    const segment = childPath[binding.prefix.length];
    if (!segment || segment.kind !== PATH_SEGMENT_KIND.property) {
      return false;
    }

    const key = `${segment.kind}:${segment.value}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    visited = true;
    visit(segment);
  }

  return visited;
}
