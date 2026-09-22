# Fish Audio Voice Design — Sports Podcast Character Pack

**Pack:** sports-character-pack-v1  
**Characters:** 0  
**Purpose:** Original synthetic sports-podcast voices for NFL, NCAAF, MLB, and NBA.

## How to create each voice in Fish Audio

1. Open **Fish Audio → Create Voice → Voice Design**.
2. Paste the character's **Voice Design Description** into the description field.
3. Paste the **Preview Text** into the optional preview-text field. This lets the generated samples speak the exact line we designed for the character.
4. Click **Generate Samples**. Fish generates two voice samples; compare both before choosing one.
5. Click **Continue**, give the saved voice the character's name, add the tags/use cases below, and set visibility to **Private** unless you specifically want the voice discoverable.
6. Save the created Fish voice. The resulting Fish **reference_id** is what eventually goes into your podcast app's ttsVoiceId field.

Fish's current guide says Voice Design is intended for original voices, asks you to describe age/gender, accent, tone/texture, pacing, mood/context, then generates two samples before the chosen design is saved as a reusable voice model. citeturn204382search0turn204382search4

> **Important:** Do not use a real broadcaster, athlete, celebrity, or other identifiable person's name as the voice target. These prompts are deliberately written as original synthetic voices.

---

## After you create the Fish voice

Do **not** paste the Fish model's display name into the app. Your app's Fish adapter expects a real 32-character hexadecimal Fish reference ID. The catalog currently uses a deliberate pending sentinel so a character cannot accidentally publish before a real voice has been assigned.

Once the voice is created, we can connect the real Fish reference IDs to these characters and run your existing long-form blind audition workflow before turning any character on for production.
