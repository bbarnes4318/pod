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
| `TTS_PROVIDER` | Speech synthesis provider | `fish` |
| `FISH_API_KEY` | Fish Audio API credential key | `...` |
| `FISH_MODEL` | Fish model for single lines + auditions. Valid: `s1`, `s2-pro`, `s2.1-pro`, `s2.1-pro-free` (free developer tier). Optional — code defaults to `s2.1-pro-free` | `s2.1-pro` on a paid account |
| `FISH_SCENE_MODEL` | Fish model for native multi-speaker scenes — the primary episode render path. Optional — code defaults to `s2-pro` | `s2-pro` |
| `FISH_ZABALA_VOICE_ID` | Bernadette "Line Two" Zabala voice (seat A) — optional, read by the seed | 32-hex Fish reference ID |
| `FISH_KEMP_VOICE_ID` | Otis "Laminate" Kemp voice (seat B) — optional, read by the seed | 32-hex Fish reference ID |
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
