// Creating a host's voice inside the app, end to end.
//
// A catalog character arrives with no voice (a FISH_DESIGN_PENDING_* marker)
// and its Fish voice brief written in sportsCharacterPack.ts. This drives the
// real page: the card offers Create voice, the designer opens with the brief
// already filled in, three takes come back and play, one is saved as the
// host's voice, and the host goes on air. Fish itself is the E2E stub
// (src/lib/providers/tts/e2eFishStub.ts); every row is checked in Postgres.
//
// Screenshots: set VOICE_SHOT_DIR to save the key states.

import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { e2eDb } from "./db";
import { E2E } from "./seed";
import { SPORTS_CHARACTER_PACK } from "../../src/lib/hosts/sportsCharacterPack";

const SHOT_DIR = process.env.VOICE_SHOT_DIR;
const ROCCO = SPORTS_CHARACTER_PACK.find((character) => character.slug === "rocco-vale")!;
const HOST_ID = "e2e-host-rocco-vale";

async function shot(page: Page, name: string, projectName: string) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${projectName}-${name}.png`), fullPage: true });
}

test.describe("Create a host voice in the app", () => {
  test.beforeEach(async () => {
    const db = e2eDb();
    await db.aiHost.deleteMany({ where: { id: HOST_ID } });
    await db.aiHost.create({
      data: {
        id: HOST_ID,
        name: ROCCO.name,
        slug: ROCCO.slug,
        role: ROCCO.role,
        worldview: ROCCO.worldview,
        speakingStyle: ROCCO.speakingStyle,
        catchphrases: ROCCO.catchphrases,
        likes: ROCCO.likes,
        dislikes: ROCCO.dislikes,
        argumentPatterns: ROCCO.argumentPatterns,
        bannedPhrases: ROCCO.bannedPhrases,
        ttsProvider: "fish",
        ttsVoiceId: "FISH_DESIGN_PENDING_ROCCO_VALE",
        intensityLevel: ROCCO.intensityLevel,
        voiceSource: ROCCO.voiceSource,
        voiceProvenanceNote: ROCCO.voiceProvenanceNote,
        isActive: false,
        isArchived: false,
        ownerId: E2E.userA.id,
      },
    });
  });

  test.afterAll(async () => {
    await e2eDb().aiHost.deleteMany({ where: { id: HOST_ID } });
  });

  test("design three takes from the character's brief, keep one, put the host on air", async ({ page }, info) => {
    await page.goto("/studio/hosts");

    await page.getByRole("button", { name: /^Need a voice \(\d+\)$/ }).click();
    const card = page.locator(".hostCard", { has: page.getByText(ROCCO.name, { exact: true }) });
    await expect(card.getByText("Voice needed")).toBeVisible();
    await expect(card.getByText("Voice brief ready")).toBeVisible();
    await expect(card.getByText("Benched")).toBeVisible();
    await shot(page, "1-needs-voice", info.project.name);

    await card.getByRole("button", { name: "Create voice" }).click();
    await expect(card.getByText(`Voice brief written for ${ROCCO.name}`)).toBeVisible();
    await expect(card.getByLabel(/Describe the voice/)).toHaveValue(ROCCO.fishVoiceDesign.description);
    await expect(card.getByLabel(/What each take says/)).toHaveValue(ROCCO.fishVoiceDesign.previewText);

    await card.getByRole("button", { name: "Create 3 takes" }).click();
    await expect(card.locator(".voiceTake")).toHaveCount(3);
    await expect(card.getByRole("button", { name: `Save as ${ROCCO.name}'s voice` })).toBeDisabled();

    // The takes are real audio the browser can play.
    await card.getByRole("button", { name: "Play take 2" }).click();
    await expect(card.getByRole("button", { name: "Stop take 2" })).toBeVisible();

    // Asking for more keeps the first round.
    await card.getByRole("button", { name: "Create 3 more takes" }).click();
    await expect(card.locator(".voiceTake")).toHaveCount(6);
    await expect(card.getByText("Round 2")).toBeVisible();

    await card.locator(".voiceTake").nth(4).getByRole("button", { name: "Use this voice" }).click();
    await expect(card.locator(".voiceTake[data-selected=true]")).toHaveCount(1);
    await shot(page, "2-takes", info.project.name);

    await card.getByRole("button", { name: `Save as ${ROCCO.name}'s voice` }).click();
    await expect(card.getByText(`${ROCCO.name} has a voice.`)).toBeVisible();

    const saved = await e2eDb().aiHost.findUniqueOrThrow({ where: { id: HOST_ID } });
    expect(saved.ttsProvider).toBe("fish");
    expect(saved.ttsVoiceId).toMatch(/^[0-9a-f]{32}$/);
    expect(saved.voiceSource).toBe("synthetic-stock");
    expect(saved.isActive).toBe(false);
    // The personality is untouched by creating a voice.
    expect(saved.worldview).toBe(ROCCO.worldview);
    expect(saved.speakingStyle).toBe(ROCCO.speakingStyle);

    await page.getByRole("button", { name: /^All hosts/ }).click();
    const readyCard = page.locator(".hostCard", { has: page.getByText(ROCCO.name, { exact: true }) });
    await expect(readyCard.getByText("✓ Voice ready")).toBeVisible();
    await readyCard.getByRole("button", { name: "Put on air" }).click();
    await expect(readyCard.getByText(`${ROCCO.name} is on air`)).toBeVisible();
    await expect(readyCard.getByText("On air", { exact: true })).toBeVisible();
    await shot(page, "3-on-air", info.project.name);

    const live = await e2eDb().aiHost.findUniqueOrThrow({ where: { id: HOST_ID } });
    expect(live.isActive).toBe(true);
  });

  test("a host with no voice cannot be put on air", async ({ page }) => {
    await page.goto("/studio/hosts");
    const card = page.locator(".hostCard", { has: page.getByText(ROCCO.name, { exact: true }) });
    await expect(card.getByRole("button", { name: "Create voice" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Put on air" })).toHaveCount(0);
  });
});
