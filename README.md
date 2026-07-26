# Take Machine - AI Sports Debate Podcast Generation Platform

Take Machine is a production-ready platform designed to automatically scrape sports talking points, score and rank them, generate debate scripts for two virtual hosts (the current roster is seeded in `prisma/seed.ts`; today that's Bernadette "Line Two" Zabala and Dutch "Attendance" Mulkey), synthesis host speech using TTS engines, stitch them into a finished MP3, and distribute approved episodes via an RSS feed.

This repository holds the **clean architecture foundation** for the project.

---

## Architecture Overview

Take Machine is designed with modularity, decoupling, and high scalability:
- **Next.js & App Router**: Powers the Admin dashboard UI and RSS feeds.
- **Vanilla CSS & CSS Modules**: Delivers a premium dark-themed sports command center interface without external dependencies like Tailwind CSS.
- **Database Layer**: Prisma ORM abstraction mapping Postgres connection tables.
- **Queue/Worker Architecture**: Redis backed BullMQ queueing structure. The background worker is decoupled and runs as a standalone Node.js script.
- **Provider Abstractions**: Decoupled interface definitions for LLM, TTS, Storage, and Sports Data providers allowing hot-swapping between integrations (OpenAI, Anthropic, ElevenLabs, Cartesia, S3, etc.).

---

## Project Structure

```
pod/
├── prisma/
│   └── schema.prisma         # Prisma Schema (Placeholder model in this phase)
├── src/
│   ├── app/
│   │   ├── admin/            # Command center layout, dashboard home & actions
│   │   ├── feed/             # Route handler for podcast RSS (Stubbed)
│   │   ├── globals.css       # Global styles (Dark command center variables)
│   │   └── layout.tsx & page.tsx
│   ├── lib/
│   │   ├── db.ts             # Prisma Client singleton
│   │   ├── redis.ts          # ioredis client singleton
│   │   ├── queue/
│   │   │   ├── podcastQueue.ts  # BullMQ Queue helper & interfaces
│   │   │   └── worker.ts        # Standalone worker script with placeholder pipeline
│   │   └── providers/
│   │       ├── llm/          # LLM interface, stub implementation & factory
│   │       ├── tts/          # TTS interface, stub implementation & factory
│   │       ├── storage/      # Storage interface, stub implementation & factory
│   │       └── sports/       # Sports data interface, stub implementation & factory
```

---

## Setup Instructions

### 1. Install Dependencies
Ensure you have Node.js 18+ installed. Clone the repository and run:
```bash
npm install
```

### 2. Configure Environment Variables
Copy the `.env.example` file to `.env`:
```bash
cp .env.example .env
```
Open `.env` and fill out your Postgres and Redis connection strings.

### 3. Setup Database (Prisma)
Once you have your Postgres database running, push the database schema:
```bash
npx prisma db push
# or
npx prisma migrate dev --name init
```

### 4. Running the Development Servers

#### Next.js Dashboard
To start the Next.js development server:
```bash
npm run dev
```
Open [http://localhost:3000/admin](http://localhost:3000/admin) to view the Command Center.

#### Standalone Queue Worker
To start the BullMQ background worker (which processes the sports scraping, scripting, and audio synthesis stages):
```bash
npm run worker
```
This script runs independently using `tsx` to process jobs queued from the dashboard.
