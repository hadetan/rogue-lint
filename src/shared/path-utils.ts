import path from "node:path";

import type { PathSegment } from "../types.js";

export function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

export function toRelative(rootPath: string, absolutePath: string): string {
  const relative = path.relative(rootPath, absolutePath);
  return normalizeSlashes(relative || ".");
}

export function propertySegment(value: string): PathSegment {
  return { kind: "property", value };
}

export function indexSegment(value: number): PathSegment {
  return { kind: "index", value };
}

export function samePath(left: PathSegment[], right: PathSegment[]): boolean {
  return serializePath(left) === serializePath(right);
}

export function serializePath(segments: PathSegment[]): string {
  return segments
    .map((segment) => (segment.kind === "property" ? `p:${segment.value}` : `i:${segment.value}`))
    .join("/");
}

export function isSerializedPathWithin(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

export function renderPath(segments: PathSegment[]): string {
  let result = "";

  for (const segment of segments) {
    if (segment.kind === "index") {
      result = `${result}[${segment.value}]`;
      continue;
    }

    result = result ? `${result}.${segment.value}` : segment.value;
  }

  return result;
}

export function renderPathWithRoot(rootName: string, segments: PathSegment[]): string {
  const rendered = renderPath(segments);
  if (!rendered) {
    return rootName;
  }

  return rendered.startsWith("[") ? `${rootName}${rendered}` : `${rootName}.${rendered}`;
}
