import type { AnalysisOptions, AnalysisResult, CliOptions } from "../types.js";
import { analyzeProject as analyzeProjectInEngine } from "../engine/run-analysis.js";

function toAnalysisOptions(options: AnalysisOptions | CliOptions): AnalysisOptions {
	return {
		cwd: options.cwd,
		targetPath: options.targetPath,
		mode: options.mode,
		configPath: options.configPath,
		includeKinds: options.includeKinds,
	};
}

/**
 * Runs rogue-lint for the provided target and returns the full analysis result.
 */
export function analyzeProject(options: AnalysisOptions): Promise<AnalysisResult>;
export function analyzeProject(options: CliOptions): Promise<AnalysisResult>;
export function analyzeProject(options: AnalysisOptions | CliOptions): Promise<AnalysisResult> {
	return analyzeProjectInEngine(toAnalysisOptions(options));
}
