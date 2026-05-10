import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import type { CliOptions, ProjectContext } from "./types.js";
import { loadPackageJson, resolveConfig } from "./config.js";
import { matchesPatterns } from "./shared/general-utils.js";
import { toRelative } from "./shared/path-utils.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function walkSourceFiles(rootPath: string): string[] {
  const result: string[] = [];
  const queue = [rootPath];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === "openspec"
      ) {
        continue;
      }

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        result.push(fullPath);
      }
    }
  }

  return result;
}

function findTsconfig(rootPath: string, explicit?: string): string | undefined {
  if (explicit) {
    const resolved = path.resolve(rootPath, explicit);
    return fs.existsSync(resolved) ? resolved : undefined;
  }

  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => path.join(rootPath, name));
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function createLanguageService(
  fileNames: string[],
  compilerOptions: ts.CompilerOptions,
  rootPath: string,
): ts.LanguageService {
  const versions = new Map(fileNames.map((fileName) => [fileName, "0"]));

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => fileNames,
    getScriptVersion: (fileName) => versions.get(fileName) ?? "0",
    getScriptSnapshot: (fileName) => {
      if (!fs.existsSync(fileName)) {
        return undefined;
      }
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf8"));
    },
    getCurrentDirectory: () => rootPath,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
  };

  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

export function loadProject(cliOptions: CliOptions): ProjectContext {
  const rootPath = path.resolve(cliOptions.targetPath ?? cliOptions.cwd);
  const config = resolveConfig(rootPath, cliOptions);
  const packageJson = loadPackageJson(rootPath);
  const configPath = findTsconfig(rootPath, config.value.tsconfig);

  let fileNames: string[];
  let compilerOptions: ts.CompilerOptions;

  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext([configFile.error], {
        getCurrentDirectory: () => rootPath,
        getCanonicalFileName: (value) => value,
        getNewLine: () => "\n",
      }));
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
      {
        allowJs: true,
        skipLibCheck: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
      },
      configPath,
    );

    fileNames = parsed.fileNames;
    compilerOptions = parsed.options;
  } else {
    fileNames = walkSourceFiles(rootPath);
    compilerOptions = {
      allowJs: true,
      checkJs: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      resolveJsonModule: true,
      esModuleInterop: true,
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noEmit: true,
    };
  }

  const program = ts.createProgram({
    rootNames: fileNames,
    options: compilerOptions,
  });
  const checker = program.getTypeChecker();
  const languageService = createLanguageService(fileNames, compilerOptions, rootPath);
  const isAnalyzable = (fileName: string): boolean => {
    const relative = toRelative(rootPath, fileName);
    if (config.value.include.length > 0 && !matchesPatterns(relative, config.value.include)) {
      return false;
    }
    if (config.value.exclude.length > 0 && matchesPatterns(relative, config.value.exclude)) {
      return false;
    }
    return true;
  };
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile)
    .filter((sourceFile) => sourceFile.fileName.startsWith(rootPath))
    .filter((sourceFile) => !sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`))
    .filter((sourceFile) => !sourceFile.fileName.includes(`${path.sep}dist${path.sep}`))
    .filter((sourceFile) => !sourceFile.fileName.includes(`${path.sep}openspec${path.sep}`))
    .filter((sourceFile) => isAnalyzable(sourceFile.fileName));
  const analyzableFiles = new Set(sourceFiles.map((sourceFile) => sourceFile.fileName));

  return {
    rootPath,
    packageJsonPath: packageJson.path,
    packageJson: packageJson.value,
    config,
    analyzableFiles,
    sourceFiles,
    program,
    checker,
    languageService,
    compilerOptions,
  };
}
