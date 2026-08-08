// The design system must not be bypassable.
//
// Before this spec, src/app/studio/** carried 437 `style={{ … }}` props and a
// scattering of raw hex values. That is why the Studio looked unrelated to
// itself page to page: a card's padding on one route had no relationship to the
// same card on another, and neither consulted a token.
//
// This is a static check — no browser needed — so it runs fast and fails the
// moment someone reaches for an inline style instead of a class.

import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

const STUDIO_DIR = path.join(process.cwd(), "src", "app", "studio");

/** Every .tsx under src/app/studio, recursively. */
function studioComponents(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) studioComponents(full, acc);
    else if (entry.name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

const rel = (f: string) => path.relative(process.cwd(), f).replace(/\\/g, "/");

/**
 * A hex colour written directly into a component. Excludes SVG path data and
 * anything inside a comment, which are matched separately below.
 */
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

test.describe("Studio design system is not bypassed", () => {
  test("no inline style={{ }} anywhere in src/app/studio", () => {
    const offenders: string[] = [];
    for (const file of studioComponents(STUDIO_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.includes("style={{")) offenders.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(
      offenders,
      `Inline styles bypass studio.css and the token set. Move each to a class:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  test("no raw hex colours in src/app/studio components", () => {
    const offenders: string[] = [];
    for (const file of studioComponents(STUDIO_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      src.split(/\r?\n/).forEach((line, i) => {
        const trimmed = line.trim();
        // Comments describe the palette constantly ("Signal Orange #FF5A1F");
        // documenting a token is not the same as hardcoding one.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        const matches = line.match(HEX);
        if (matches) offenders.push(`${rel(file)}:${i + 1}  ${matches.join(", ")}  ${trimmed.slice(0, 80)}`);
      });
    }
    expect(
      offenders,
      `Colour belongs in a CSS custom property, not a component:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  test("every studio page sets its header through the shell, not a local .pageTitle", () => {
    const offenders: string[] = [];
    for (const file of studioComponents(STUDIO_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      src.split(/\r?\n/).forEach((line, i) => {
        if (/className=("|')[^"']*\bpage(Title|Sub)\b/.test(line)) {
          offenders.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(
      offenders,
      `.pageTitle/.pageSub were hand-placed on every page and cost ~100px of chrome each. ` +
        `Use <StudioPageHeader title subtitle /> instead:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
