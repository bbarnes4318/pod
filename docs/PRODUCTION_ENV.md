# Take Machine - Production Environment Configuration Guide

This document describes the environment variable configurations required for deploying Take Machine to production via Coolify.

> [!CAUTION]
> **Real Secrets Security Rules**:
> - Never commit real credentials, S3 API keys, passwords, or preview tokens to the Git repository.
> - Input all real keys inside the Coolify console environment variable panel only.
> - If any credential key or token was printed in plain text during configuration or verification, rotate the key before public release.

---

## 1. Hetzner Object Storage (S3-compatible) Configuration
Hetzner Object Storage provides S3-compatible endpoints for hosting final audio, transcripts, and show notes. 
For the Helsinki location (`hel1`), configure the S3 variables exactly as follows:

```env
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://hel1.your-objectstorage.com
S3_REGION=hel1
S3_BUCKET=take-machine-media
S3_ACCESS_KEY_ID=SET_YOUR_REAL_KEY_IN_COOLIFY
S3_SECRET_ACCESS_KEY=SET_YOUR_REAL_KEY_IN_COOLIFY
S3_PUBLIC_BASE_URL=https://take-machine-media.hel1.your-objectstorage.com
```

*Note: `hel1` stands for **Helsinki location one**.*

---

## 2. Required Production Environment Variables

These variables **must** be present in the Coolify configuration. The application will fail production readiness audits if any of these are missing or contain placeholder values.

| Variable Name | Description | Value / Template |
| :--- | :--- | :--- |
| `NODE_ENV` | Environment mode | `production` |
| `APP_BASE_URL` | Public HTTPS domain url | `https://podcast.hopwhistle.com` |
| `NEXT_PUBLIC_APP_BASE_URL` | Client public HTTPS domain url | `https://podcast.hopwhistle.com` |
| `COOKIE_SECURE` | Enforce secure SSL cookies | `true` |
| `ADMIN_BASIC_AUTH_ENABLED` | Protect admin dashboard | `true` |
| `ADMIN_USERNAME` | Administrator login username | `admin` (or custom name) |
| `ADMIN_PASSWORD` | Administrator login password | A strong, random alphanumeric string. *Do not use defaults.* |
| `DATABASE_URL` | Connection URL for PostgreSQL | `postgresql://<user>:<password>@<host>:5432/<database>` |
| `REDIS_URL` | Connection URL for Redis queue | `redis://default:<password>@<host>:6379` |
| `RSS_PREVIEW_TOKEN` | Auth token for private feed previews | A strong, random alphanumeric string used for `/rss/preview?token=<token>` |
| `LLM_PROVIDER` | Topics, research briefs, classification, show notes. `gemini` \| `anthropic` \| `openai` \| `stub` | `gemini` |
| `GEMINI_API_KEY` | Gemini authentication key | `AIza...` |
| `GEMINI_MODEL` | Model for the non-writing stages | `gemini-3.6-flash` |
| `SCRIPT_LLM_PROVIDER` | Overrides the provider for script writing only | `gemini` |
| `SCRIPT_LLM_MODEL` | Model for script outline + acts (the quality-critical stage) | `gemini-3.6-flash` |
| `VERIFY_LLM_PROVIDER` | Overrides the provider for grounding rewrites + the semantic fact-check reviewer | `gemini` |
| `VERIFY_MODEL` | Model for verification | `gemini-3.6-flash` |
| `ANTHROPIC_API_KEY` | Anthropic authentication key — **keep set: this is the rollback target** | `sk-ant-...` |
| `ANTHROPIC_MODEL` | Anthropic model for the non-writing stages | `claude-sonnet-5` |

### LLM roles, and why there are four

Four roles resolve independently, and they **inherit**:

```
verifier  <-  fact-checker  <-  script writer  <-  global
```

| Role | Variables | What it does |
| :--- | :--- | :--- |
| Global | `LLM_PROVIDER` | topics, topic classification, research briefs, show notes |
| Script writer | `SCRIPT_LLM_PROVIDER` / `SCRIPT_LLM_MODEL` | episode outline + the three movements (~64% of token spend) |
| Fact-checker | `FACTCHECK_LLM_PROVIDER` / `FACTCHECK_LLM_MODEL` | semantic fact-check reviewer |
| Verifier | `VERIFY_LLM_PROVIDER` / `VERIFY_MODEL` | self-verify grounding rewrites |

A **mixed** configuration is normal, not an edge case. The readiness audit
resolves all four and requires credentials **only** for providers a configured
role actually uses — carrying an unused Anthropic key while Gemini is primary
does not fail the audit. `/admin/configuration` prints the resolved
provider/model for each role, so "what is writing my scripts right now" is
answerable without reading env vars.

> [!IMPORTANT]
> Every LLM variable must be set on **both** the web and worker services. The
> worker runs the whole generation pipeline; the web app runs studio creation
> and the readiness audit. Setting them on one service produces a system that
> half works.

### Gemini-primary (production default)

```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=SET_IN_COOLIFY_ONLY
GEMINI_MODEL=gemini-3.6-flash

SCRIPT_LLM_PROVIDER=gemini
SCRIPT_LLM_MODEL=gemini-3.6-flash

VERIFY_LLM_PROVIDER=gemini
VERIFY_MODEL=gemini-3.6-flash
```

### Anthropic rollback

Change **only** these provider/model values and redeploy web + worker. No code
change is required.

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=SET_IN_COOLIFY_ONLY
ANTHROPIC_MODEL=claude-sonnet-5

SCRIPT_LLM_PROVIDER=anthropic
SCRIPT_LLM_MODEL=claude-opus-5

VERIFY_LLM_PROVIDER=anthropic
VERIFY_MODEL=claude-sonnet-5
```

### Mixed (recommended if only script quality regresses)

```env
LLM_PROVIDER=gemini
GEMINI_MODEL=gemini-3.6-flash

SCRIPT_LLM_PROVIDER=anthropic
SCRIPT_LLM_MODEL=claude-opus-5

VERIFY_LLM_PROVIDER=gemini
VERIFY_MODEL=gemini-3.6-flash
```

### Optional Gemini tuning

| Variable | Purpose | Default |
| :--- | :--- | :--- |
| `GEMINI_REQUEST_TIMEOUT_MS` | Per-request `AbortController` deadline | `180000` |
| `GEMINI_MAX_RETRIES` | Retries for 408/429/5xx and transport failures | `2` |
| `GEMINI_THINKING_LEVEL` | `minimal` \| `low` \| `medium` \| `high`. Unset = Google's per-model default (`medium` on `gemini-3.6-flash`) | unset |
| `GEMINI_THINKING_HEADROOM_TOKENS` | Extra `maxOutputTokens` ceiling on top of the caller's request | `8192` |

**Why the headroom exists.** Gemini 3 models think by default, thinking tokens
are billed at the output rate, and Google does **not** document them as exempt
from `maxOutputTokens`. A 16,000-token script movement whose reasoning ate the
budget returns truncated JSON, which reads like a model quality problem rather
than a configuration one. Raising a ceiling costs nothing — billing is what the
model actually emits — so the adapter adds headroom and clamps to the model's
documented **65,536**-token output limit, warning out loud if a caller ever
requests more than the model can produce.
| `TTS_PROVIDER` | Speech synthesis provider | `fish` |
| `FISH_API_KEY` | Fish Audio API credential key | `...` |
| `FISH_MODEL` | Fish model for single lines + Character Studio auditions only. SDK-canonical ids are `s1` / `s2-pro`; `s2.1-pro-free` is the free-tier id from the official curl example. Optional — code defaults to `s2.1-pro-free` | leave unset |
| `FISH_SCENE_MODEL` | Fish model for native multi-speaker scenes — the **primary** episode render path. `s2-pro` (paid, code default) and `s2.1-pro-free` (free tier) both render scenes — free-tier scene support verified live 2026-07-25. A 402 "Insufficient API credit" means Fish **API credit** (separate from platform credit) is unfunded: fund at fish.audio/app/developers or use the free model | `s2.1-pro-free` until API credit is funded |
| `FISH_ZABALA_VOICE_ID` | Bernadette "Line Two" Zabala voice (seat A) — optional, read by the seed | 32-hex Fish reference ID |
| `FISH_MULKEY_VOICE_ID` | Dutch "Attendance" Mulkey voice (seat B) — optional, read by the seed | 32-hex Fish reference ID |
| `FISH_HOST_A_VOICE_ID` | Seat A voice at synthesis time. No reseed needed; covers a missing or invalid seeded voice | 32-hex Fish reference ID |
| `FISH_HOST_B_VOICE_ID` | Seat B voice at synthesis time | 32-hex Fish reference ID |

Voice fallbacks are keyed by **seat**, not by host name. Set the `HOST_A` /
`HOST_B` pair on both the web and worker apps and a roster change can never
drop a host onto the shared `FISH_TTS_VOICE`. A host that does reach the
shared default logs a warning naming them and their seat — grep the worker
log for `[TTS Voice]`. Full order: docs/TTS_PROVIDERS.md.
| `SPORTS_PROVIDER` | Sports news/data provider | `api-sports` |
| `API_SPORTS_KEY` | API-Sports authorization key | API key from provider |

---

## 3. Optional/Warning Environment Variables

These variables are optional. Missing values will trigger **warnings** on readiness checks but will **not** block deployment.

| Variable Name | Description | Default / Recommendation |
| :--- | :--- | :--- |
| `THE_ODDS_API_KEY` | API key for odds fetching | Key from theoddsapi |
| `BALLDONTLIE_API_KEY` | API key for stats fetching | Key from balldontlie |
| `DEEPGRAM_API_KEY` | API key for transcription validation | Key from deepgram |
| `CARTESIA_API_KEY` | Backup TTS Cartesia API key | Key from cartesia |
| `PODCAST_IMAGE_URL` | Podcast RSS cover image URL | `https://take-machine-media.hel1.your-objectstorage.com/assets/take-machine-cover.png` |

*Note: SportsDataIO is legacy fallback only and is not required for production deployment.*
