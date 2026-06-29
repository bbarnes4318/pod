# Take Machine - MVP Rehearsal Checklist

This checklist guides the operator through preflight validation and executing a complete, real episode generation run on the production server.

---

## 1. Preflight Deployment Verification
Ensure the following checks pass before starting the episode rehearsal:

- [ ] **Console Access**: Coolify dashboard is accessible at [http://178.156.153.87:8000](http://178.156.153.87:8000).
- [ ] **Web Service Running**: The Next.js web application is successfully compiled and running.
- [ ] **Worker Service Running**: The BullMQ queue worker is running in the background.
- [ ] **Database Reachable**: The Postgres container is active, reachable, and migrations are applied.
- [ ] **Redis Connected**: The Redis container is active and reachable by both web and worker services.
- [ ] **Health Endpoint**: [https://podcast.hopwhistle.com/api/health](https://podcast.hopwhistle.com/api/health) returns `ok: true`.
- [ ] **Readiness Endpoint**: [https://podcast.hopwhistle.com/api/readiness](https://podcast.hopwhistle.com/api/readiness) passes all database, Redis, S3, and environment audits.
- [ ] **Admin Basic Auth**: Accessing `/admin` prompts for credentials; invalid entries return `401 Unauthorized`.
- [ ] **Secrets Masking**: Navigating to `/admin/configuration` displays config status ("Configured" or "Missing") and masks all sensitive API keys and tokens.
- [ ] **Public RSS Feed**: [https://podcast.hopwhistle.com/rss](https://podcast.hopwhistle.com/rss) returns a valid, empty XML feed.
- [ ] **Preview RSS Feed Authentication**: Accessing `/rss/preview?token=invalid` returns `401 Unauthorized`.
- [ ] **Secure Cookies**: `COOKIE_SECURE=true` is enabled in production variables.
- [ ] **Public Hostnames**: All public app URLs are using `https://podcast.hopwhistle.com`.
- [ ] **S3 Public Base URL**: S3 region is set to `hel1` and public media CDN URL is configured correctly.
- [ ] **Podcast Cover Image**: A real podcast cover image has been uploaded to Hetzner object storage at the key `assets/take-machine-cover.png`.

---

## 2. One Real Episode Rehearsal Run
Execute the entire pipeline in order, validating each transition without shortcuts:

### Step A: Data Ingest
- [ ] Go to **Data Ingest Management** (`/admin/data-sources`).
- [ ] Trigger real data ingestion for the target league (e.g. NBA/NFL).
- [ ] Verify sports news and scores are loaded into the database (verify Data Ingested counts on the admin dashboard).

### Step B: Topic Selection
- [ ] Navigate to the **Sports Debate Topic Engine** (`/admin/topics`).
- [ ] Generate debate topic candidates from real stored data.
- [ ] Select one strong, high controversy candidate and click **Approve**.

### Step C: Research & Scripting
- [ ] Go to **Debate Research Dossiers** (`/admin/research-briefs`).
- [ ] Generate a production-grade research brief for the approved topic.
- [ ] Go to the **LLM Script Review Console** (`/admin/scripts`).
- [ ] Generate a debate script for hosts Max Voltage and Dr. Linebreak based on the brief.
- [ ] Read through the generated dialogue. Modify dialogue if any fake fallback quotes or ungrounded statistics exist.
- [ ] Click **Approve Script**.

### Step D: Fact Checking & QA
- [ ] Navigate to the **Fact Checking Panel** (`/admin/fact-checks`).
- [ ] Trigger a fact-checking audit for the approved script.
- [ ] Resolve any failures or warnings by updating the script, then re-auditing. Script status must be `approved` with a `passed` fact check.

### Step E: Audio Generation
- [ ] Go to **Dialogue Voice Synthesis** (`/admin/audio-segments`).
- [ ] Click **Generate Audio Segments** to trigger ElevenLabs/Cartesia voice synthesis.
- [ ] Verify that every dialogue line in the script maps to exactly one ready `AudioSegment` and has a valid URL.
- [ ] Navigate to **Final Audio Stitching** (`/admin/final-audio`).
- [ ] Click **Stitch Final Audio** to run the server-side FFmpeg concatenation job.
- [ ] Listen to the stitched MP3 file to verify sound leveling and line gaps.

### Step F: Content Assets & Publishing Prep
- [ ] Go to **Content Assets Generator** (`/admin/content-assets`).
- [ ] Generate metadata, description, transcript, and show notes.
- [ ] Navigate to the **Podcast RSS Publishing** console (`/admin/rss`).
- [ ] Verify that the publication checklist on the left has passed all validation gates (no mock checks or fake green states).
- [ ] Click **Prepare Episode** to resolve public file sizes and lock the RSS GUID.
- [ ] Open the preview feed: `https://podcast.hopwhistle.com/rss/preview?token=<your_preview_token>`.
- [ ] Verify the XML contains the prepared episode item with correct enclosure tags, audio URLs, durations, and transcript links.
- [ ] Click **Publish Episode**.
- [ ] Refresh the public RSS feed at `https://podcast.hopwhistle.com/rss` and confirm the episode item is live.
- [ ] Copy the public RSS link and run it through a standard podcast RSS XML validator to confirm formatting compliance.

---

## Rehearsal Constraints
- Do not inject mock/fake episodes or database counts to bypass steps.
- Only fix real blockers; if warning states appear but don't prevent publishing, record them for future refinement.
- Follow all basic authentication gates.
