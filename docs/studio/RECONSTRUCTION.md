# Studio reconstruction — manifest

Branch `ui/studio-reconstruction`, cut from `origin/main` @ `fd6b2c4`.
This file is the durable record: what was wrong, what the new structure is,
what has been built, what has **not**, and how to continue. Update it with
every milestone. Continue from here; do not restart the design.

---

## 0. Current status (2026-11-28) — read this first

### Part 4 — final completion (four draft PRs, none merged, none verified)

`main` = `575e69d` (#171 and #172 merged). Each PR below branches from it and
stands alone. **Nothing in Part 4 has been run in a browser, against a
database, in CI, or against a live model or Fish.** Only tsx unit checks and
`tsc` ran, locally, with no database.

| PR | Branch | Priority | What it is | Checks run |
| --- | --- | --- | --- | --- |
| #173 | `release/immutable-artifacts` | P0 follow-up | Content-addressed audio keys; row lock on every Script.content write (admin save is optimistic with a content hash); re-mixing a published episode no longer replaces the public audio. Only a gated re-publish promotes it. | `test:release-integrity` 54/54, `test:business-engine` 96/96. Three new DB checks written, **not run**. |
| #174 | `studio/executive-producer` | P1 | AI Executive Producer: model drafts a reasoned brief (role `script_outline`); each section can be kept, edited, redrafted or dropped; deterministic fallback labelled as such; brief stored on `Episode.editorialBrief` and injected into both script engines. Sports and business. | `test:executive-brief` passes. **Has a migration.** No live model call. |
| #175 | `studio/chemistry-audition` | P3 | Chemistry audition: 2–3 hosts plus a subject and style; the model writes a scene from stored traits, Fish voices it; up to three takes side by side; cast the pair onto a show. Measurements only, no score. | `test:chemistry-audition` 28/28. No live call. |
| #176 | `studio/audio-workspace` | P2 (part) | Real decoded waveform of the master; ffmpeg-measured loudness/peak panel kept apart from estimates; render lookup scoped by script in the query; `content-visibility` for long line lists. | `test:audio-workspace` 7/7. Bucket CORS unknown. |

**Capability matrix (honest):**

| Capability | State |
| --- | --- |
| Immutable recordings and masters | Built (#173), unit-checked only |
| Script edit concurrency, including admin | Built (#173), unit-checked only |
| Published audio immutable until re-publish | Built (#173), unit-checked only |
| AI Executive Producer, per-section control | Built (#174), no live model run |
| Brief reaches script generation | Built (#174), source-checked |
| Waveform / measured loudness | Built (#176); waveform depends on bucket CORS |
| Chapters, per-cue mix controls, multi-version compare in the mix | **Not built** |
| Chemistry audition | Built (#175), no live run |
| P4 UX (Quick Start recs, RundownBuilder split, distinct creation modes, library pagination, analytics queries, mobile) | **Not started** |
| P5 browser failures, P6 integrated validation, P7 end-to-end, P8 review | **Not run.** Need the server or a cloud session (standing rule 1); live steps need an authorised budget. |

Slip to record: during Part 4, `testBookendRenderGate` and
`testPostTtsRenderGate` were run locally by mistake. They start an embedded
Postgres; both failed on a Prisma-client mismatch. Do not run them
on the owner's machine.

### Part 3 status as of 2026-11-27 evening (historical)

#### Current status (2026-11-27, evening)

**Part 2 is merged.** PRs #164 to #170 all merged into `main` on 2026-11-27;
`main` is at `bb69ac931b20dfa5b2145f97a24c8c37bbf87914`. Merging deployed web and
worker. The table in section 0a is the record of what each PR was when it was
written; the "Open" in its State column is history, not the present.

**Merged is not verified.** What section 0a says Part 2 never had is still true
of `main` today: no browser, no CI run, no database, no Playwright, no live
provider. Nothing below should be read as "it works".

### Part 3 — finishing and proving (in progress)

| Priority | State |
| --- | --- |
| 0 Release integrity | **Built and validated in a cloud session, on branch `release/integrity-gate` (draft PR #171), not merged.** On commit `386650f`: CI `full` = **FAIL**, `44 passed, 2 failed, 0 blocked`; both failures (`script-queue-tracking`, `business-engine`) fail identically on `main`. Database test on real PostgreSQL: `19/19 checks passed` (it found and fixed one defect: a waiting edit timed out after 5s). Browser spec: `21 passed`. No audio was voiced or mixed, no provider called. See `docs/studio/RELEASE_INTEGRITY.md`. |
| 1 Real AI Producer (model-assisted planning) | Not started. Today's "AI Producer" is the deterministic ranker from #165. |
| 2 Professional audio workspace | Not started. `MixView` and `StudioPlayer` are as Part 1/2 left them. |
| 3 Talent chemistry audition | Not started. |
| 4 Remaining creative details | Not started. |
| 5 Browser and database validation of integrated `main` | **Not run.** Standing rule 1: not on the owner's machine. Needs the server or a cloud session. |
| 6 End-to-end workflow acceptance (sports, business, talent, recovery, security) | Not run. Live provider steps also need an authorised budget. |
| 7 Independent product review of the rendered app | Not run (depends on 5). |

Known red on `main`, found while working on Priority 0 and **not** caused by it:
`npx tsx --conditions=react-server src/scripts/testHonestControls.ts` reports
`7 passed, 2 failed` (both `D-04`, the created-episode screen). It is not in
`scripts/ci/run.sh`, so CI would not have caught it.

Also red on `main` at `bb69ac9` (run in a cloud session, 2026-11-28), so local CI
cannot pass on any branch until they are fixed:

- CI `script-queue-tracking`: `7 passed, 1 failed` ("Studio hands the exact
  newly-created episode id to startDebate").
- CI `business-engine`: `95 passed, 1 failed` ("a broken-JSON reply from Claude
  is asked for once more", M2 live run 5).
- Playwright: `studio-chrome` "New show: first interactive control is within
  160px of the top" (all three widths) and `sound-branding` "Test 51"
  (desktop). Five more tests in those two suites failed intermittently on the
  branch (a different set on each run); neither suite's pages are changed by
  Priority 0.

## 0a. Part 2 as written (2026-11-27, before merge) — historical

Part 1 (PR #160, sections 1 to 11 below) built the foundation. Part 2 built the
workflows as seven pull requests. **All seven are now merged** (see section 0);
when this section was written none was, and none had been seen in a browser.

| PR | Branch | Priority | State |
| --- | --- | --- | --- |
| #164 | `studio/arch-limits` | 6 Architectural limits | Open. tsc clean, unit checks pass. |
| #165 | `studio/creation` | 1 Episode creation | Open. tsc clean, unit checks pass. |
| #166 | `studio/workspace` | 2 Episode workspace | Open. tsc clean, unit check passes (fake model). Needs CI `full`. |
| #167 | `studio/talent` | 3 Talent Studio | Open. tsc clean, unit checks pass. |
| #168 | `studio/shows-intel` | 4 Shows and editorial intelligence | Open. tsc clean, unit checks pass (fake model). |
| #169 | `studio/library` | 5 Audio, publishing, analytics, mobile | Open. tsc clean, unit check passes. |
| (this) | `studio/validation-fixes` | 7 Validation | `show-format` assertion fixed; axe in both themes; this document. |

`studio/integration` is all seven merged together (no conflicts), for validation
only. It is not for merging.

### What every PR has NOT had

- **No browser.** No page of Part 2 has been rendered. Layout, both themes, phone
  width, focus order and every interaction are unverified. There are **no new
  screenshots**; `docs/ux-audit/after/` is still Part 1.
- **No CI.** `bash scripts/ci/run.sh` has not run on any Part 2 branch. Standing
  rule 1 forbids running it on the owner's machine. CI: pending, to be run on
  the server.
- **No database.** Every new Prisma query (batched progress, desk counts and
  paging, episode library counts, analytics, publishing) is type-checked only.
- **No Playwright.** Existing test ids were kept by reading the specs, not by
  running them.
- **No live provider.** No LLM or TTS call was made. The two new model calls
  (passage revision, show Quick Start) were exercised with FAKE model replies.
  A complete live Sports or Business episode has not been produced; that needs
  the owner's explicit go-ahead and a budget.

### What did run (owner's machine, Node, no services)

On `studio/integration` (all branches together):

| Command | Result line |
| --- | --- |
| `npx tsc --noEmit -p .` | no output, exit 0 |
| `npx tsx src/scripts/testAnthropicStructuredSchema.ts` (fake fetch) | `ok  anthropic structured output: native JSON format, validator honoured, one repair, schema-only 400 fallback, truncation, request budget` |
| `npx tsx src/scripts/testDeskStages.ts` | `ok  desk stages: database filter and row label agree on 15 combinations` |
| `npx tsx src/scripts/testProductionPlan.ts` | `ok  production plan: deterministic, eligible-only, objective-led, honest about shortfalls` |
| `npx tsx src/scripts/testCastingFit.ts` | `8 passed, 0 failed` |
| `npx tsx src/scripts/testAnalyticsInsights.ts` | `6 passed, 0 failed` |
| `npx tsx src/scripts/testShowQuickStart.ts` (fake model) | `6 passed, 0 failed` |
| `testPassageRevision` (react-server, fake model) | `ok  passage revision + quality report (fake model): lines kept, new figures flagged, bad reply discarded, stale audio found` |
| `testStudioRundown` (react-server) | `36 passed, 0 failed` |
| `testHostStudioCapabilities` (react-server) | `12 passed, 0 failed` |
| `testShowForgeCapabilities` (react-server) | `10 passed, 0 failed` |
| `testBusinessIntelligence` (react-server) | `29 passed, 0 failed` |

### Priority 1 — Episode creation (#165)

**Implemented**
- Three approaches over ONE rundown, chosen on the Show step:
  - **AI Producer**: a creative objective becomes a complete proposed production
    (stories, order, lead, hosts, sound), each pick with the stored facts behind
    it. Swap, remove, or take any part into Manual.
  - **Guided**: four decisions in turn (lead story, companions, hosts, sound),
    each with a recommendation from the research.
  - **Manual**: the full builder, behaviour unchanged.
- All three write the same state and create through `createStudioEpisode`, so a
  proposal is what gets made and switching approach loses nothing.
- One entry for Sports and Business: business shows are in the same show chooser
  and open their approved research with the existing Generate button.
- Show hosts, length and preferences are inherited as before; the draft now also
  remembers the approach and the objective (existing draft JSON, no migration).
- `RundownBuilder.tsx` 1,166 → about 900 lines; pieces in `create/parts.tsx`,
  approaches in `create/ApproachPanels.tsx`, rules in `lib/studio/productionPlan.ts`.

**Remains / limits**
- Recommendations are deterministic (heat, evidence counts, word overlap with
  the objective). No model ranks the proposal. Marked `ponytail:` with the
  upgrade path.
- The objective steers story choice only; script generation has no input for it.
- The step panels (Topics, Hosts, Production) are still inline in the builder.

### Priority 2 — Episode workspace (#166)

**Implemented**
- **AI passage revision**: tick up to 12 consecutive lines, give an instruction,
  preview before/after, accept / try again / change instruction. The model may
  only reword the given lines (validated); figures not in the original passage
  are flagged before accepting. Service: `lib/services/passageRevision.ts`.
- **Invalidation**: an accepted revision is written like a hand edit (lines
  marked for fact re-check, business script re-audited). Recorded lines whose
  text changed are detected as stale; publishing is refused while any exist;
  one-click re-voice.
- **One quality inspector** on Overview (`lib/services/qualityInspector.ts`):
  must-fix versus worth-a-look, read from the real gates, each item opening the
  stage and the script line (`#line-N`).
- **Script and player**: play from any line; the spoken line is marked.
- Fix: a re-voiced line's audio row now stores the text it was voiced from.

**Remains / limits**
- Stale-audio detection covers per-line voicing only, not scene-voiced episodes.
- Re-voice is one queue job per line, 12 per click.
- The mix view and waveform were not rebuilt into one timeline composition;
  the Research and Rundown stages are unchanged from Part 1.
- Line positions in the audio are approximate (the mix view's own timeline).

### Priority 3 — Talent Studio (#167)

**Implemented**: casting-card library with voice preview; sectioned profile;
five-step workflow (Identity, Personality, Performance, Voice, Final review)
over the same fields and actions; deterministic personality recommendations and
complementary casting with the facts shown (`lib/hosts/castingFit.ts`);
`CharacterStudio.tsx` split into modules. No server action changed.

**Remains / limits**: no personality "chemistry read" exists in the backend, so
two-host audition links to the existing blind voice comparison. Recommendations
are rules, not a model. Voices are compared by stored id only. A voice with no
provenance now blocks Final review until one is chosen.

### Priority 4 — Shows and editorial intelligence (#168)

**Implemented**: AI Quick Start for shows (proposal with reasons, accepted
through the existing create action); business show page as Overview / Discover /
Investigate / Approve / Produce with a computed next step and old `?tab=` links
kept; sports evidence inspector on the desk (`?take=`); search results open the
selected host, take, topic or episode stage.

**Remains / limits**: Quick Start has never run against the real model. It does
not propose sound style or teams (the create action does not accept them).

### Priority 5 — Audio, publishing, analytics, mobile (#169)

**Implemented**: episode artwork grid beside the table, with database counts,
query-side search and paging; publishing as a per-episode release checklist from
the real gate; analytics that says "no data" instead of 0 and states the numbers
behind each takeaway; audio library with type tabs, search, metadata filters and
preview; a phone tab bar. Fixed: `/studio/publish` listed every account's
finished episodes (now owner-scoped); analytics bars drew at zero height.

**Remains / limits**: publishing reads the gate per episode (8 per page); the
episode table reads script data for 24 rows; analytics loads its range into
memory and lists 50 episodes; the audio library filters in the browser.

### Priority 6 — Architectural limits (#164)

**Implemented**
- Production activity: one batched read, six queries per page of 24 instead of
  about ten per episode; exact in-flight and ready counts; paging in the
  activity menu; a failed read is "Not read" and is never counted as running.
  The 40-episode and 8-episode ceilings are gone.
- Editorial desk (business): counts and stage filters run in the database, list
  paged at 50, a linked topic opens off-page. Ownership unchanged.
- Claude structured output: request budget per call (default 6; the stacked
  retries allowed 24 or more), truncation raises the cap once then fails
  clearly, fallback only for a schema 400 and remembered, schema conversion no
  longer drops fields named like constraints, logs carry no reply text.

**Remains / limits**: the batched read still loads each in-flight episode's
script JSON (for the line count and the release gates).
`ANTHROPIC_STRUCTURED_MAX_REQUESTS` is optional; unset means 6.

### Priority 7 — Validation

**Done**: `show-format` asserted configuration snapshot `version` 3; the writer
stamps 5, or 6 with a diversity context. The test now asserts the writer's
current versions from the module's own constants, and still asserts the cast is
frozen. axe now runs in charcoal and light. Neither has been run yet.

**Not done**: browser tests at the five widths, screenshots, rendered
inspection, `full` build, deployment readiness, live Sports and Business
episodes. All need the server or a cloud session; the live episodes also need
the owner's approval and a budget.

### Merge order and after merging

Any order works; the branches were merged together without conflicts. If GitHub
reports a conflict after an earlier one lands, it will be a one-line overlap.
None has a migration or a new required environment variable.

---

## 1. Honest status (Part 1, as merged in #160)

| | |
| --- | --- |
| Built | Workstream A (foundation) and B (creator headquarters) in full; the business half of C; the structural part of D; a first pass of E. |
| Not built | See section 7. The largest gaps are AI-assisted script revision, the three-mode episode creation, the Talent creation workflow, and the audio workspace. |
| Verified by | Local CI `fast` (exit 0), ten Playwright suites, screenshots at five widths in both themes, and a hands-on browser pass. All run in a cloud session on 2026-11-27, against the seeded test app. Section 8 has every command and result line. |
| Still failing | `show-format`: 1 of 2 desktop tests fails (expects configuration snapshot `version` 3, the pipeline writes 5). The spec and `src/lib` are byte-identical to `main`, so this is not from this branch; it was left alone because the snapshot belongs to the generation pipeline. |
| **Not verified** | Anything that needs a live provider: script generation, fact-check, voices (TTS), mix, show notes, voice design, business research runs. No LLM or TTS call was made. The tests use seeded database rows and silent audio. Production data, real cover art and long real titles have not been seen in the new layout. `full` CI (Docker image build and boot) was not run: this branch does not touch `prisma/`, the worker, the `Dockerfile`, `package.json` or startup code. |
| CI | `══ fast: PASS ══  43 passed, 0 failed, 0 blocked in 2m48s` on commit `619b13f` (Node 20.20.2). |

The browser acceptance criteria are met **for seeded data**: screenshots at
five widths, zero serious or critical axe violations on 16 routes at three
widths in the charcoal theme, and no capture wider than its viewport. Axe was
not run in the light theme; that theme was checked by eye at 1440 only.

---

## 2. Product audit (before)

Read from the code on `main`, not from a running app.

1. **Two homes, neither a home.** `/studio` was "The Board", a sports take
   browser. A business creator landed on a sports page. Nothing on it said
   what was in production, what was stuck, or what needed a decision.
2. **Sports owned the navigation.** "Sports desk" was a top-level nav group;
   business research had no place outside an individual show's six tabs.
3. **No way to answer "what should I make next?" for business.** Topics were
   only visible per show, in unranked cards, mixed with rejected ones.
4. **Audio stopped at the page edge.** The only player lived on the episode
   page. No list could play anything; leaving the page stopped playback.
5. **Production was invisible unless you were looking at it.** State existed
   only on the one episode's console.
6. **Search found pages, not work.** The palette listed navigation only.
7. **Creators were sent to the ops console.** The episode overview linked
   `/admin/rss`, `/admin/final-audio`, `/admin/scripts`; the create flow
   linked `/app/podcasts/:id` for show settings.
8. **Identity was a generic light SaaS skin** (indigo on grey-white, Inter
   only, pills and cards on every page).
9. **Three privacy holes** (fixed here, see section 6):
   - `/studio/episodes/[id]` rendered any episode to any signed-in account.
   - `/app/episodes/[id]` rendered any episode to anyone, signed in or not.
   - `/app` Discover listed every episode with audio, whatever its owner or
     stage.

---

## 3. Information architecture (after)

Primary navigation, each named for a job:

| Destination | Route | Also lights up for |
| --- | --- | --- |
| Home | `/studio` | |
| Shows | `/studio/shows` | `/studio/shows/*` |
| Editorial desk | `/studio/desk` | `/studio/takes` |
| Episodes | `/studio/episodes` | `/studio/create` |
| Talent | `/studio/hosts` | `/studio/auditions` |
| Audio library | `/studio/audio` | |
| Publishing | `/studio/publish` | |
| Analytics | `/studio/analytics` | |

Utility (sidebar foot + account menu): Plan & usage, Settings, theme.
"Your shows" is a second sidebar section, on every page.

Global: **New episode** (topbar, `N`), **New show** (`+` beside "Your shows",
Shows page, palette), search (`Ctrl/⌘ K` or `/`), `G` then a letter to jump
(`H S D E T A P`), production activity (topbar), player dock (bottom).

Sports and Business are equal: one Editorial desk with two sides; the side
that opens follows the shows the viewer has.

---

## 4. Design system

Source of truth: the token block at the top of `src/app/studio/studio.css`,
plus `src/app/studio/control-room.css` for everything this branch added.
`docs/studio-design.md` still describes the chrome, spacing, copy and
enforcement rules, which are unchanged.

- **Two themes, one token set.** Charcoal (default) and Paper (light).
  `data-theme` on `.studioShell`, chosen by the `tm_theme` cookie, read on
  the server so the first byte of HTML is already the right theme.
- **One accent: the tally lamp** (`--accent`). Primary action, selection,
  live state. Nothing else.
- **Type.** Inter for work. Newsreader (`--font-editorial`) only where the
  product speaks as an editor: the Home briefing, a show's name, a topic's
  headline.
- **Shape.** Radius 4 / 6 / 8 / 10. Pills are status only.
- **Contrast.** Every text token was computed against every surface step in
  both themes; all pairs are ≥ 4.5:1 (lowest: `--text-subtle` on
  `--surface-3`, 4.83 dark / 4.94 light). axe-verified in the charcoal theme
  (section 8); the light theme is computed only.
- **Show art.** A show without a cover gets its initials on a token field,
  hue chosen by a stable hash of its id (`showHue`, `showInitials` in
  `src/app/studio/lib.ts`).
- **A production as one line** (`.prodRow`): lamp + state word + headline.
  State is never colour alone.

New shared components:

| Component | File | Purpose |
| --- | --- | --- |
| `StudioAudioProvider`, `PlayButton` | `StudioAudio.tsx` | One player for the Studio; survives navigation. |
| `ActivityMenu`, `ProductionRow` | `ActivityMenu.tsx` | Production state from every page. |
| `getStudioProductions` | `productions.ts` | The single read behind Home and the activity menu. |
| `searchStudio`, `getStudioActivity` | `searchActions.ts` | Owner-scoped search and activity. |
| `BusinessDesk` | `desk/BusinessDesk.tsx` | Ranked research board + evidence inspector. |

---

## 5. What was built, by workstream

### A — Product foundation (done)
- New token set and two themes; theme toggle; editorial typeface.
- Shell: flat eight-item nav, "Your shows", utility area, operator-only ops
  link, keyboard shortcuts, recents.
- Command palette: searches owned shows, episodes, talent, sports takes and
  business topics on the server; recents; shortcut hints.
- Studio-wide player dock. It yields when the episode page's own waveform
  player starts, so two things never play at once. While open it adds its own
  height to the page's bottom padding and lifts the episode action bar.
- Production activity menu, polling every 30s while the tab is visible.

### B — Creator headquarters (done)
- **Home** (`/studio`): one briefing (a fixed priority rule over real state),
  Needs you, In production, Ready to release (with play), Worth making next,
  Your shows. First-time creators get the five-step path instead.
- **Shows**: mastheads with art, purpose, cadence, last activity, New episode.
- **Show headquarters (sports)**: masthead, playable episode catalog,
  storyline board, side rail (next beat, hosts, sound and release, quality).
- **Show headquarters (business)**: masthead, pipeline-ordered sections.
- "New episode" from a show opens the rundown **inside that show**
  (`/studio/create?show=<id>`), on the Topics step.

### C — Editorial intelligence (business side done; sports side moved)
- `/studio/desk`: the sports board, unchanged in behaviour, moved off Home.
- `/studio/desk?desk=business`: every open topic across the viewer's
  business shows, ranked by the stored opportunity score, filterable by
  pipeline stage (Discover / Investigate / Approve / Produce) and by show.
  The inspector separates **measured** signals (sources cited, demand
  strength, verified claims, achieved information advantage) from
  **estimates** (opportunity score, potential advantage, confidence,
  evidence quality), lists key claims with verdicts and source links, lists
  weaknesses, and carries the existing approve / research / produce buttons.

### D — Episode production (structure done; editor not)
- Episode tabs are lifecycle stages with done / current / not-started lamps:
  Overview, Rundown, Script, Audio and mix, Release. The page opens on the
  stage that needs the visitor.
- New Rundown stage (segments from the real script).
- Promo clip lives in Release.
- Ownership check on the page (see section 6).

### E — Talent and audio (first pass)
- "Hosts" is "Talent"; voice auditions sit under it.
- Play buttons in the episode library, Home and the show catalog.

### F — Distribution and refinement (not started)

---

## 6. Route migration and compatibility

| Route | Before | Now |
| --- | --- | --- |
| `/studio` | The Board (sports) | Home |
| `/studio/desk` | did not exist | Editorial desk (sports board; `?desk=business` for research) |
| `/studio?league=…&conf=…&team=…` | Board drill-down | Redirects to `/studio/desk` with the same query. |
| `/studio/takes` | Takes | Unchanged; breadcrumb to the desk. |
| `/studio/hosts` | Hosts | Talent (same URL). |
| `/studio/create?show=<id>` | ignored | Starts the rundown inside that show. |
| `/studio/episodes/[id]#promote` | Promote tab | Opens Release (alias). |
| `/app/create`, `/app/podcasts*` | redirects into Studio | Unchanged. |
| `/app` (Discover) | every episode with audio | Published episodes only. |
| `/app/episodes/[id]` | any episode by id | Published, or the viewer's own. |
| `/app/episodes` | viewer's episodes (listening list) | **Kept.** Owner-scoped, read-only. Two e2e specs depend on it. |
| `/app/login`, `/app/signup`, `/rss*`, `/api/episodes/[id]/download` | | Unchanged. |
| `/admin/*` | operator console | Unchanged. Linked from Studio for operators only. |

No routes were deleted. No database migration. No environment variable.

---

## 7. Remaining work after Part 1 (superseded by section 0 where they differ)

Ordered by dependency. Nothing below has been started unless it says so.

**Must happen before merge**
Items 1 to 4 of the original list (CI, Playwright, five-width screenshots,
both themes) are done; see section 8. What is left:
1. Decide what to do about `show-format` (failing on `main` too; see section 1).
2. Run axe with the `tm_theme=light` cookie. Not done.
3. One real episode through the whole pipeline on the deployed app, to see
   real titles, real audio and a real business dossier in the new layout.

**Known rough edges seen in the screenshots, not fixed**
- Business show page at 390px: the show's name is squeezed out of the topbar by
  "Run discovery" (the crumb and subbar still say where you are).
- Editorial desk, business side, below 1100px: the inspector sits above the
  list. Deliberate (tapping a row reloads to the top), but worth a second look.
- The Audio library is skinned, not redesigned.

**Workstream B**
- Show creation: Quick start (AI recommends a whole configuration from a
  sentence) beside the existing Show Forge. Needs a new server action over
  the existing LLM routing; Show Forge is the Custom path.
- Business show Overview: fold "Deeper context" and the checklist into the
  masthead layout.

**Workstream C**
- Sports desk: give takes the same inspector (the research brief exists on
  `TopicCandidate.researchBrief`).

**Workstream D**
- Episode creation in three named modes. The existing `mode`
  (manual / automatic / hybrid) maps onto Manual / AI Producer / Guided;
  this is presentation over `RundownBuilder`, which should be split into
  per-step modules while doing it. `studio-rundown.spec.ts` is the contract.
- Business episodes are created from the desk, not from `/studio/create`.
  The create flow should offer the viewer's business shows and hand off.
- Script editor: select a passage and ask for a revision. **No such service
  exists**; it needs a new server action that calls the script model, shows
  a preview, and on accept goes through the same save path as a manual edit
  so verification and audio are invalidated exactly as they are today.
- Quality control view: one list of release blockers versus warnings,
  linking to the line. The data is in `getEpisodeTranscriptVM().gate`,
  `evaluateDownstreamBlock` and `businessVerification`.

**Workstream E**
- Talent library as casting cards with voice preview; the creation workflow
  in Identity / Personality / Performance / Voice / Review steps over the
  existing `CharacterStudio` fields.
- Audio workspace: `MixView` and `StudioPlayer` in one timeline composition.

**Workstream F**
- Episode library: artwork grid view beside the table.
- Publishing as a release checklist (`getPublishState().publishBlockers`).
- Analytics: distinguish "no data yet" from zero.
- A mobile bottom bar. Today the phone layout is the desktop one with the
  nav in a drawer.

---

## 8. What was actually run

### 8a. Cloud validation, 2026-11-27 (final code commit `619b13f`)

Linux container, Node 20.20.2, Docker for CI's PostgreSQL 16 and Redis 7,
Playwright 1.61.1 with Chromium. The app under test is `next dev` on port 3311
with a throwaway seeded PostgreSQL (`tests/e2e/global-setup.ts`). **No LLM,
TTS, research or payment provider was called by anything below.**

| Command | Result line |
| --- | --- |
| `bash scripts/ci/run.sh fast` (first run, commit `ef9a168`) | `══ fast: PASS ══  43 passed, 0 failed, 0 blocked in 2m49s` |
| `bash scripts/ci/run.sh fast` (final, commit `619b13f`) | `══ fast: PASS ══  43 passed, 0 failed, 0 blocked in 2m48s`, exit 0 |
| `npm run build` | Ran as CI's `build` step in a clean export: `PASS build (45s)` |

Playwright, one suite at a time, `npx playwright test tests/e2e/<suite>.spec.ts --trace off`.
Final result on the final code unless noted. "Skipped" is the suites' own
desktop-only guard on the tablet and phone projects, not something switched off.

| Suite | Final | First run on this branch |
| --- | --- | --- |
| `studio-tokens` | 12 passed | 12 passed |
| `studio-chrome` | 60 passed | 57 passed, 3 failed (Home first-control budget) |
| `studio-a11y` | 54 passed | 52 passed, 2 failed (focus probe landed on Next's dev badge) |
| `studio-board` | 27 passed | 27 passed |
| `studio-rundown` | 24 passed, 42 skipped | same |
| `owner-isolation` | 10 passed, 20 skipped | 8 passed, 2 failed (test read the page too early) |
| `sound-diversity` | 11 passed, 22 skipped | 2 passed, 9 failed (waited for the wrong shell; fails on `main` too) |
| `player-bar-overlap` | 2 passed, 4 skipped | same (run before the last CSS commits; it tests `/app`, which they do not touch) |
| `audio-asset-isolation` | 5 passed, 10 skipped | same (as above) |
| `show-format` | **1 passed, 1 failed**, 4 skipped | same. Not fixed; see section 1 |
| `studio-screenshots` (`SHOT_PHASE=after BUSINESS_PODCASTS_ENABLED=1`) | 126 passed, 89 skipped | 126 captures; `overflow.json` listed 3 pages wider than their viewport, now none |

**Bugs found and fixed in the product**
- `/studio?league=NFL` did redirect, but late: Home's skeleton flashed and the
  browser logged a React error. Now a real HTTP 307 from `src/proxy.ts`.
- Phone topbar: page actions pushed the title out and the business show page
  scrolled sideways (483px in a 390px viewport).
- Two "New episode" buttons side by side in a show page's topbar.
- Command palette results overlapped each other at 390px.
- Audio library: bare browser controls on charcoal, sideways scroll at 390 and
  1280, and (once it scrolled inside itself) a table the keyboard could not reach.

**Assertions changed, and why**
- `studio-chrome`: Home is a documented exception to the 160px first-control
  budget, held at 240px (measured 186 / 214 / 236). Home opens on a sentence
  and then its button; the button cannot come first. Intentional new design.
- `studio-a11y`: the focus-ring probe ignores `<nextjs-portal>`, Next's
  dev-mode badge, which is not in a production build.
- `owner-isolation`: the six open-by-URL tests now wait for the not-found page
  instead of reading the body once. Stricter, not looser: the new episode leak
  checks could previously pass on a half-loaded page.
- `sound-diversity`: waits for the Studio shell instead of the `/app` player
  bar, which the sound page stopped rendering in when it moved into the Studio.

**Harness changes** (no test logic)
- `global-setup.ts`: makes the throwaway database directory usable when the
  run is root (embedded PostgreSQL drops privileges and could not start).
- `playwright.config.ts`: 1920x1080 and 1280x800 projects, only when
  `SHOT_PHASE` is set, so the assertion suites still run three widths.
- `studio-screenshots.spec.ts`: adds its own business show, research topics and
  a finished episode (the shared seed has none), a light-theme pass, UI-state
  captures, and the overflow report.

**Screenshots** (`docs/ux-audit/after/`, 129 files): 19 routes at 1920, 1440,
1280, 768 and 390 in charcoal; the same 19 at 1440 in light; and
`state-*` for the collapsed sidebar, activity menu, phone drawer, command
palette and player dock. Looked at: every phone capture of the pages this
branch built, the tablet set for Home, desk, show and episode, the light set
for Home, desk and episode, and all `state-*`. Not every one of the 129 was
opened; the overflow report covers all of them for sideways scroll.

**By hand in the browser** (a scripted Chromium session, results read back)
- Ctrl+K: "overtime" returns The Overtime Show; "awaiting" returns the
  episode and Enter opens it; another account's rows never appear. Pass.
- `G` then `S` / `D` / `E` land on Shows, Editorial desk, Episodes. Pass.
- Theme toggle: sets `tm_theme`, the server's HTML already carries
  `data-theme="light"` on reload (so no flash), toggles back. Pass.
- Play from the Episodes list, navigate to Shows, then Home: still playing,
  position advancing (2.4s, 4.5s, 6.1s). Pass.
- Starting the episode page's own player pauses the dock. Pass. The action bar
  sits directly above the dock (775-836 and 836-900 of 900), no overlap.
- `/studio/create?show=<id>` opens on step 2, Topics, inside that show. Pass.
- `/studio?league=NFL`: failed cleanly at first (see bugs); passes after the fix.
- The seeded script-draft episode opens on the Script stage. Pass.

### 8b. Before the cloud run (owner's machine, no browser)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | clean (no output) |
| `testTopicFreshnessAutomation` | PASS |
| `testShowForgeDiscoverability` | 16 passed, 0 failed (was failing on `main`: it asserted the copy "Build a show", which `main` no longer has; the assertion now checks the "New show" action) |
| `testShowForgeCapabilities` | 10 passed, 0 failed |
| `testBusinessIntelligence` | 29 passed, 0 failed |
| `testHostStudioCapabilities` | 12 passed, 0 failed |
| `testProductionChain` | 14 passed, 0 failed |
| `testHonestControls` | 9 passed, 0 failed |

### 8c. Never run

| Check | Why |
| --- | --- |
| Live LLM / TTS / research | Needs provider credit. Not attempted, not faked. |
| `bash scripts/ci/run.sh full` | Not required for this change (see section 1). |
| axe in the light theme | Not done. |
| lint (`npm run lint`) on its own | Not run separately. |

---

## 9. Capability preservation

Nothing in `src/lib`, `prisma/`, the worker, the queue, prompts or providers
was changed. Every server action keeps its signature.

| Capability | Touched? | Where it is now |
| --- | --- | --- |
| Sports intelligence, take board | Moved | `/studio/desk` |
| Business research, dossiers, approval | Presentation added | Show page (unchanged) + desk |
| Topic lifecycle, freshness window | No | |
| Show configuration, Show Forge | No | Show page disclosure, `/studio/shows/new` |
| Host personality, voice design, provenance | Renamed only | Talent |
| TTS providers, model routing | No | |
| Script generation, fact-check | No | Episode, Script stage |
| Editorial gate, release gate, publish gate | No | Episode Overview and Release |
| Sound design, mix, line regeneration | No | Episode, Audio and mix |
| Continuity, listener learning | No | |
| Queue contracts, job logs | Read only | Home, activity menu |
| Auth, ownership | **Tightened** | Three reads now enforce it |
| Existing episodes, shows, RSS, audio URLs | No | |

---

## 10. Deploy and rollback

- No migration, no new environment variable, no worker change.
- Merging to `main` deploys web and worker automatically.
- After deploy, `/api/readiness` shows the commit.
- **Rollback:** revert the merge commit and let it deploy. Nothing to undo in
  the database. A `tm_theme` cookie left in a browser is ignored by the old
  code.
- One behaviour change users will notice immediately: `/studio` is Home, and
  the sports board is under "Editorial desk".

---

## 11. Decisions worth knowing

- **Charcoal is the default theme.** The brief asked for a production
  aesthetic; the light theme is one click away and remembered.
- **The briefing is a rule, not a model.** Same state, same advice, every
  word read from a row. An LLM-written briefing would be slower, cost money
  on every page view, and could say something untrue.
- **Home reads full progress for at most 8 in-flight episodes** (about ten
  queries each). Marked `ponytail:` in `productions.ts` with the upgrade
  path.
- **`/app/episodes` stays.** It is an owner-scoped listening list, and two
  specs that cannot be run here depend on it.
- **Competitive study was not done in a browser.** The structural choices
  (command palette and `G` chords, a persistent player dock, a list-plus-
  inspector research board, lifecycle stages as the episode's navigation)
  come from general knowledge of Linear, Spotify for Creators, Descript and
  NotebookLM, not from fresh inspection of them.
