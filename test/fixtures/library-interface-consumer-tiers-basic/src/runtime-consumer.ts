import type { InternalContract } from "./internal.js";

export function readRuntime(contract: InternalContract): number {
	return contract.runtime + contract.mixed;
}
