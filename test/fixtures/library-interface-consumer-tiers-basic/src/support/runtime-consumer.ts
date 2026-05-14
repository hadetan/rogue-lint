import type { InternalContract } from "../internal.js";

export function readSupportRuntime(contract: InternalContract): number {
	return contract.supportRuntime + contract.mixed;
}
