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
export function getResolvedSpreadPropertyNames(binding: TrackedObjectBinding): string[] | undefined {
  const collection = getCollectionInfo(binding.trackedObject, binding.prefix);
  if (!collection || collection.kind !== TRACKING_COLLECTION_KIND.object) {
    return undefined;
  }

  const names: string[] = [];
  const seen = new Set<string>();

  for (const childPath of collection.childPaths) {
    if (childPath.length !== binding.prefix.length + 1) {
      continue;
    }

    const segment = childPath[binding.prefix.length];
    if (!segment || segment.kind !== PATH_SEGMENT_KIND.property) {
      return undefined;
    }

    if (seen.has(segment.value)) {
      continue;
    }

    seen.add(segment.value);
    names.push(segment.value);
  }

  return names.length > 0 ? names : undefined;
}

/**
 * Returns the exact property segments that remain visible through a resolved object spread binding.
 */
export function visitResolvedSpreadPropertySegments(
  binding: TrackedObjectBinding,
  visit: (segment: PathSegment) => void,
): boolean {
  const propertyNames = getResolvedSpreadPropertyNames(binding);
  if (!propertyNames) {
    return false;
  }

  for (const propertyName of propertyNames) {
    visit({
      kind: PATH_SEGMENT_KIND.property,
      value: propertyName,
    });
  }

  return true;
}
