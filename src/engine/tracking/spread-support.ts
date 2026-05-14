import type {
  PathSegment,
} from "../../types.js";
import type { TrackedObjectBinding } from "./model.js";
import { getCollectionInfo } from "./state.js";

/**
 * Returns the exact property segments that remain visible through a resolved object spread binding.
 */
export function getResolvedSpreadPropertySegments(binding: TrackedObjectBinding): PathSegment[] | undefined {
  const collection = getCollectionInfo(binding.trackedObject, binding.prefix);
  if (!collection || collection.kind !== "object") {
    return undefined;
  }

  const propertySegments: PathSegment[] = [];
  const seen = new Set<string>();

  for (const childPath of collection.childPaths) {
    if (childPath.length !== binding.prefix.length + 1) {
      continue;
    }

    const segment = childPath[binding.prefix.length];
    if (!segment || segment.kind !== "property") {
      return undefined;
    }

    const key = `${segment.kind}:${segment.value}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    propertySegments.push(segment);
  }

  return propertySegments.length > 0 ? propertySegments : undefined;
}
