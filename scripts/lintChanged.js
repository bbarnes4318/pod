#!/usr/bin/env node
// Report NET-NEW ESLint errors introduced by this branch vs the PR base
// (default: feat/unified-episode-creation), considering ONLY changed files.
//
// For each changed .ts/.tsx/.js file it counts eslint errors on the working
// tree AND on the base version (linted from a temporary sibling copy so the
// same eslint config applies), and reports the delta. Exits non-zero if any
// file introduces net-new errors — i.e. "zero net-new" == clean exit.
//
// Usage: node scripts/lintChanged.js [baseRef]
/* eslint-disable @typescript-eslint/no-require-imports -- plain Node CJS tooling script */
"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const base = process.argv[2] || process.env.LINT_BASE || "feat/unified-episode-creation";
const sh = (cmd) => execSync(cmd, { encoding: "utf8" });

function eslintErrorCount(file) {
  try {
    const out = sh(`npx eslint -f json "${file}"`);
    const j = JSON.parse(out);
    return j[0] ? j[0].errorCount : 0;
  } catch (e) {
    try {
      const j = JSON.parse(e.stdout);
      return j[0] ? j[0].errorCount : 0;
    } catch {
      return null; // eslint could not parse (e.g. ignored file)
    }
  }
}

function baseErrorCount(file) {
  // Materialize the base version next to the real file so eslint resolves the
  // same config, then lint + clean up.
  let baseContent;
  try {
    baseContent = execSync(`git show ${base}:${file}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return 0; // file did not exist in base → all its errors are net-new
  }
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const tmp = path.join(dir, `.__baselint__${path.basename(file, ext)}${ext}`);
  fs.writeFileSync(tmp, baseContent);
  try {
    return eslintErrorCount(tmp) ?? 0;
  } finally {
    fs.unlinkSync(tmp);
  }
}

let files = [];
try {
  const ranges = [
    `git diff --name-only --diff-filter=ACMR ${base}...HEAD`,
    "git diff --name-only --diff-filter=ACMR HEAD",
    "git diff --name-only --diff-filter=ACMR --cached",
  ];
  const set = new Set();
  for (const r of ranges) for (const f of sh(r).split("\n")) { const t = f.trim(); if (t) set.add(t); }
  files = [...set]
    .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
    .filter((f) => !path.basename(f).startsWith("_")) // skip local scratch scripts
    .filter((f) => fs.existsSync(f));
} catch (err) {
  console.error("Could not compute changed files against", base, "-", err.message);
  process.exit(2);
}

if (files.length === 0) {
  console.log(`No changed lintable files vs ${base}.`);
  process.exit(0);
}

console.log(`Net-new ESLint errors vs ${base} (changed files only):\n`);
let totalDelta = 0;
const offenders = [];
for (const f of files) {
  const branch = eslintErrorCount(f) ?? 0;
  const baseline = baseErrorCount(f);
  const delta = branch - baseline;
  totalDelta += Math.max(0, delta);
  const flag = delta > 0 ? "  <-- NET-NEW" : "";
  if (delta > 0) offenders.push(f);
  console.log(`  ${String(delta > 0 ? "+" + delta : delta).padStart(4)}  (branch ${branch} / base ${baseline})  ${f}${flag}`);
}

console.log("");
if (totalDelta > 0) {
  console.log(`✗ ${totalDelta} net-new lint error(s) across ${offenders.length} file(s).`);
  process.exit(1);
}
console.log("✓ Zero net-new lint errors vs " + base + ".");
