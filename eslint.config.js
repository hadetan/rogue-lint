import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const sourceFiles = ["src/**/*.ts"];
const testAndToolingFiles = ["test/**/*.ts", "vitest.config.ts", "eslint.config.js"];

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "openspec/**",
      "test/fixtures/**",
    ],
  },
  {
    files: ["**/*.{js,ts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "curly": ["error", "all"],
      "eol-last": ["error", "always"],
      "eqeqeq": ["error", "always"],
      "no-console": "off",
      "no-multiple-empty-lines": ["error", { max: 1, maxEOF: 1, maxBOF: 0 }],
      "no-trailing-spaces": "error",
      "no-unused-expressions": "off",
      "no-unused-vars": "off",
      "no-var": "error",
      "object-shorthand": ["error", "always"],
      "prefer-const": ["error", { destructuring: "all" }],
      "@typescript-eslint/no-unused-expressions": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: sourceFiles,
    rules: {
      "no-console": "error",
    },
  },
  {
    files: testAndToolingFiles,
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["src/cli.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
