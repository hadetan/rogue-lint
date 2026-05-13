import type { InternalContract } from "../src/internal.js";

export function readOnlyFromTests(contract: InternalContract): number {
	return contract.testOnly + contract.mixed;
}
