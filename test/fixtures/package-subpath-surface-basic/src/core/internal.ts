export type InternalOptions = {
  secret: string;
};

export function normalizeSecret(value: string): string {
  return value.trim();
}
