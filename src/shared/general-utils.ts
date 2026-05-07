import { Minimatch } from "minimatch";

export function matchesPatterns(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new Minimatch(pattern, { dot: true }).match(value));
}

export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

export function getVersion(): string {
  return "0.0.1";
}
