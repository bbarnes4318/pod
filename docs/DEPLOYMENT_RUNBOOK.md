# Take Machine - Deployment Runbook (Coolify)

This runbook outlines the steps to deploy Take Machine to a Hetzner Cloud virtual server running Coolify.

## Server Infrastructure Details
- **Provider**: Hetzner Cloud
- **IP Address**: `178.156.153.87`
- **Coolify Console URL**: [http://178.156.153.87:8000](http://178.156.153.87:8000)
- **Production Domain**: [https://podcast.hopwhistle.com](https://podcast.hopwhistle.com)
- **Operating System**: Ubuntu 24.04 LTS
- **Stack**: Next.js, Prisma, PostgreSQL, Redis, BullMQ queue worker, FFmpeg/FFprobe, Hetzner Object Storage (S3-compatible)

---

## Firewall / Network Settings
Ensure the Hetzner firewall or local `ufw` configuration has the following rules allowed:
- **Port 22 (SSH)**: Allowed for operator access.
- **Port 80 (HTTP)**: Allowed for web traffic and Let's Encrypt validation.
- **Port 443 (HTTPS)**: Allowed for production SSL traffic.
- **Port 8000 (TCP)**: Allowed until Coolify configuration is complete.

---

## Coolify Setup Instructions

Follow these step-by-step instructions to initialize the application services:

### 1. Account Initialization
1. Navigate to the Coolify console at [http://178.156.153.87:8000](http://178.156.153.87:8000).
2. Create or login to the administrator account.

### 2. Create the Project
1. Go to **Projects** in the sidebar.
2. Click **Create New Project** and name it `Take Machine`.

### 3. Setup PostgreSQL Database Service
1. Inside the `Take Machine` project, click **Add New Resource** &rarr; **PostgreSQL**.
2. Keep the default configurations or define custom production database credentials.
3. Mark down the internal connection URL: `postgresql://<user>:<password>@<postgres-host>:5432/<database>`. This will be your production `DATABASE_URL`.

### 4. Setup Redis Queue Service
1. Inside the project, click **Add New Resource** &rarr; **Redis**.
2. Configure a strong password.
3. Mark down the internal connection URL: `redis://default:<password>@<redis-host>:6379`. This will be your production `REDIS_URL`.

### 5. Setup Web Service
1. Click **Add New Resource** &rarr; **Public Repository** or **Private Repository** to connect your Take Machine GitHub repository.
2. Select the repository branch `main`.
3. Set the resource type to **Docker Image** or **Dockerfile**. Coolify will read the `Dockerfile` in the root of the repository.
4. Name this service `take-machine-web`.
5. Configure the build parameters:
   - **Build Command**: `npm run build`
   - **Start Command**: `npm run start:web` (starts the web app only — it does **not** migrate; see [Database Migrations](#database-migrations))
6. In **Domains**, configure `https://podcast.hopwhistle.com`. Let's Encrypt will automatically provision the SSL certificate.

### 6. Setup Worker Service
1. In the same project, add another resource from the **same repository** and `main` branch.
2. Name this service `take-machine-worker`.
3. Configure the build parameters:
   - **Build Command**: `npm run build`
   - **Start Command**: `npm run start:worker` (starts the worker only — it does **not** migrate; see [Database Migrations](#database-migrations))
4. **Important**: Under this service's settings, do **not** configure any public domains or SSL endpoints. This service runs completely in the background.
5. **Important**: do **not** add a migration command to this service's start/pre-deploy configuration. The worker must never compete with the web service as a migration owner.

---

## Environment Variables Configuration

Copy all variables from `.env.production.example` and paste them into the **Environment Variables** panel of both the **web** and **worker** services inside Coolify.

> [!CAUTION]
> **Secret Handling Rules**:
> - Never commit real credentials, S3 API keys, passwords, or preview tokens to the Git repository.
> - Input all real keys inside the Coolify console environment variable panel only.
> - If any credential key or token was printed in plain text during configuration or verification, rotate the key before releasing the application publicly.

### Shared-Server Concurrency Optimization
Because the deployment target is a shared 8 GB RAM Hetzner virtual server, we must limit resource footprint:
- Set `WORKER_CONCURRENCY=1`
- Set `TTS_WORKER_CONCURRENCY=1`
- Set `AUDIO_STITCH_WORKER_CONCURRENCY=1`
- Set `CONTENT_WORKER_CONCURRENCY=1`
- Set `RSS_WORKER_CONCURRENCY=1`
This prevents multiple heavy FFmpeg stitching jobs or multiple OpenAI/TTS generations from exhausting CPU/RAM threads.

---

## Podcast Cover Image Asset
The system uses the configured cover image from `PODCAST_IMAGE_URL`:
`https://take-machine-media.hel1.your-objectstorage.com/assets/take-machine-cover.png`

**Operator Action**:
1. Log into your Hetzner Object Storage console.
2. Upload a square podcast cover image (minimum 1400x1400px, recommended 3000x3000px, PNG or JPEG) to the bucket `take-machine-media` at the path:
   `assets/take-machine-cover.png`
3. Ensure this file has its permissions set to **public-read** so that podcast aggregators can download the cover.

---

## Database Migrations

> [!CAUTION]
> **Single migration owner.** Exactly ONE release step runs `prisma migrate deploy`.
> The **web** and **worker** containers must **never** migrate on startup — `start:web`
> and `start:worker` deliberately contain no migration command, and nothing may add one
> back (enforced by `npm run test:deployment-contract`).
>
> - **Never** run `prisma migrate deploy` simultaneously from the web and the worker.
> - **Never** expose the migrated database to old web or worker code.
> - **Do not** roll back only the code after a coordinated migration.
> - **Use a forward fix** if the new deployment fails after the migration has run.

The one migration command, run manually by a single designated release process
(one Coolify terminal/pre-deploy job — not the web service, not the worker service):

```bash
npm run prisma:migrate:deploy
```

### A. Normal deployment (no pending migrations)
1. Build **one** image from **one** commit.
2. Deploy **web** and **worker** from that same commit/image.
3. Run the smoke tests in §C.

### B. Deployment WITH pending migrations (coordinated)
This is the procedure required by
[`prisma/migrations/20260714120000_topic_lifecycle_and_snapshots/SAFETY_REPORT.md`](../prisma/migrations/20260714120000_topic_lifecycle_and_snapshots/SAFETY_REPORT.md)
— that report remains the authority on *why*; this section is the operator checklist.

1. **Confirm the exact commit/image** that will be deployed to **both** web and worker.
2. **Enable maintenance mode** / stop routing write traffic to the current web app.
3. **Pause and drain** the `podcast-generation` BullMQ queue.
4. **Disable** recurring/scheduled generation.
5. **Confirm** no active episode-creation transaction and no in-flight `build:episode` worker remains.
6. **Back up** the affected tables (`TopicCandidate`, `EpisodeTopic`) — or the full database.
7. **Run the migration exactly once**, from one designated release job/terminal:
   ```bash
   npm run prisma:migrate:deploy
   ```
8. **Deploy web and worker** from the same compatible commit/image (§A step 2).
9. **Run the smoke tests** in §C *before* restoring traffic.
10. **Resume** the queue and schedulers.
11. **Disable maintenance mode** and restore traffic.

### C. Smoke tests (before restoring traffic)
- Application loads.
- Authentication works.
- Studio loads.
- Create a draft episode.
- Topic selection works.
- Script generation can begin.
- The worker connects and processes jobs.
- `/studio/takes` loads.
- Logs show no Prisma/schema errors.

---

## SSL and DNS Verification
1. Ensure the A record for `podcast.hopwhistle.com` points to `178.156.153.87` in your DNS provider.
2. In Coolify, verify the domain is attached and click redeploy on the web service.
3. Once completed, verify endpoints:
   - **Health check**: [https://podcast.hopwhistle.com/api/health](https://podcast.hopwhistle.com/api/health)
   - **Readiness check**: [https://podcast.hopwhistle.com/api/readiness](https://podcast.hopwhistle.com/api/readiness)
   - **Public feed**: [https://podcast.hopwhistle.com/rss](https://podcast.hopwhistle.com/rss)
   - **Preview feed**: [https://podcast.hopwhistle.com/rss/preview?token=invalid](https://podcast.hopwhistle.com/rss/preview?token=invalid) (Must return 401).
