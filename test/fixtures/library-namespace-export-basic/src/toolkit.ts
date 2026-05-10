export function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export type ToolkitConfig = {
  prefix: string;
};
