import type { AnalysisResult, CliOptions } from "../types.js";
import { analyzeProject as analyzeProjectInEngine } from "../engine/run-analysis.js";

/**
 * Runs rogue-lint for the provided target and returns the full analysis result.
 */
export function analyzeProject(cliOptions: CliOptions): Promise<AnalysisResult> {
	return analyzeProjectInEngine(cliOptions);
}
