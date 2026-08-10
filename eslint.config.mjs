import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees are FULL nested checkouts of this same repo. Left
    // unignored they are linted as if they were source: they once inflated a
    // run to ~76,000 problems against ~1,000 real ones, which hides every
    // genuine error behind noise from code that is not even on this branch.
    // Worktrees belong outside the repo; this is the backstop for when one
    // gets created inside it anyway.
    ".claude/**",
    "**/.claude/worktrees/**",
  ]),
]);

export default eslintConfig;
