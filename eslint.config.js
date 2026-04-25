// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * ESLint flat config for claude-conductor.
 *
 * Discipline-encoding rules per the parent plan's professional-product
 * code-style standards:
 *   - @typescript-eslint/no-explicit-any: error
 *   - @typescript-eslint/no-non-null-assertion: error
 *   - @typescript-eslint/no-unused-vars: error (argsIgnorePattern: ^_)
 *
 * Audience: future-Claude reading errors when extending the plugin.
 * Errors should be actionable, code references the rule by name.
 *
 * @see ../parent-plan-section-on-professional-product-standards
 * @see ../decisions/phase-0.md (entry: eslint.config.js approval)
 */

import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "build/**", "*.tsbuildinfo"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
];
