import { normalizeSecret } from "./internal.js";

export type PublicConfig = {
  value: string;
};

export function buildPublicThing(config: PublicConfig): string {
  return normalizeSecret(config.value);
}
