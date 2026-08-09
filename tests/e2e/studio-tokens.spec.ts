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
    // ONE exception, and it is a rule rather than a loophole: an inline style
    // that sets only CSS CUSTOM PROPERTIES. Data-driven geometry — a waveform
    // marker at `left: 63.2%`, a host span's width — cannot live in a
    // stylesheet, because the value comes from the data. Passing it as a
    // variable keeps the *styling* in the class and lets the component supply
    // only the number:
    //
    //   <div className="playerHostSpan" style={{ "--span-start": "63.2%" }} />
    //
    // Anything that sets a real CSS property (color, padding, display…) is
    // still a violation.
    const CUSTOM_PROP_ONLY = /style=\{\{\s*(?:"--[\w-]+"|'--[\w-]+')\s*:/;
    const offenders: string[] = [];
    for (const file of studioComponents(STUDIO_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!line.includes("style={{")) return;
        if (CUSTOM_PROP_ONLY.test(line)) return;
        // A prettier-wrapped style prop puts the first key on the NEXT line:
        //   style={{
        //     "--span-start": `${…}%`,
        // Judging it by the opening line alone reports it as a violation.
        const next = (lines[i + 1] ?? "").trim();
        if (/^(?:"--[\w-]+"|'--[\w-]+')\s*:/.test(next)) return;
        offenders.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
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
        // Canvas cannot read a CSS custom property, so StudioPlayer resolves
        // tokens off the document at paint time. cssToken()'s second argument is
        // the value to use if the property is missing (SSR, or a stylesheet that
        // has not applied yet) — a documented mirror of globals.css, not a
        // second definition. Narrow by design: only a cssToken() fallback.
        if (/cssToken\(\s*"--[\w-]+"\s*,/.test(line)) return;
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

  // This one is deliberately WIDER than src/app/studio/**, because the bug it
  // catches was: a class deleted from the studio stylesheet was still used by a
  // component OUTSIDE that directory (PodcastWizard, which /studio/shows/new
  // renders). The guard's scope did not match the change's scope, so it saw
  // nothing while the component rendered unstyled on every surface for the rest
  // of the branch.
  //
  // .pageSub is defined in NO stylesheet, so any use of it anywhere is dead.
  // .pageTitle is deliberately NOT checked here: it is alive and correct in
  // app/admin/layout.css, which the 15 admin pages that use it do import.
  test("no component anywhere reaches for .pageSub, which no stylesheet defines", () => {
    const APP_DIR = path.join(process.cwd(), "src", "app");
    const offenders: string[] = [];
    for (const file of studioComponents(APP_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      src.split(/\r?\n/).forEach((line, i) => {
        if (/className=("|`)[^"`]*\bpageSub\b/.test(line)) {
          offenders.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(
      offenders,
      `.pageSub is defined in no stylesheet — these render unstyled:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
