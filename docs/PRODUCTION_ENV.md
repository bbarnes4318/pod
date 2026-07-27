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
| `LLM_PROVIDER` | Topics, research briefs, classification, show notes | `anthropic` |
| `ANTHROPIC_API_KEY` | Anthropic authentication key | `sk-ant-...` |
| `ANTHROPIC_MODEL` | Model for the non-writing stages | `claude-sonnet-5` |
| `SCRIPT_LLM_PROVIDER` | Overrides the provider for script writing only | `anthropic` |
| `SCRIPT_LLM_MODEL` | Model for script outline + acts (the quality-critical stage) | `claude-opus-5` |
| `LLM_ROUTING_PROFILE` | Role-based routing profile: `legacy` \| `frontier_development` \| `free_independent` \| `custom`. **`legacy` is the default and the one-variable rollback** — see [LLM_ROLE_ROUTING.md](./LLM_ROLE_ROUTING.md) | `legacy` |
| `APP_DEPLOYMENT_STAGE` | `development` \| `staging` \| `live`. Governs the hosted-trial-endpoint advisory. NOT `NODE_ENV` — a development deployment still builds for production | `development` |
| `LLM_ALLOW_LEGACY_FALLBACK` | May a role fall back to paid Anthropic/OpenAI after its free candidates fail? **Default `false`** = comparison mode: a role that exhausts its free candidates fails, so an A/B result measures the candidate rather than Anthropic. `true` = resilient mode for full-pipeline runs; every paid call is audited in the log. A *configuration* failure can only cross into paid when this is set explicitly | `false` |
| `NVIDIA_API_KEY` | NVIDIA NIM credential — required only when a profile routes a role to `nvidia` | `nvapi-...` |
| `ZAI_API_KEY` | Z.ai **general-purpose** API credential (not the coding plan) — required only when a profile routes a role to `zai` | `...` |
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
