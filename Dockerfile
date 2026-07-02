# Stage 1: Build dependency and app build
FROM node:20-slim AS builder
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

# Stage 2: Production runner
FROM node:20-slim AS runner
WORKDIR /app

# Install runtime dependencies (ffmpeg, ffprobe, and openssl for Prisma)
RUN apt-get update && apt-get install -y ffmpeg openssl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Copy built artifacts and source files (source files are needed for TSX worker runtime)
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public
COPY --from=builder /app/tsconfig.json ./tsconfig.json

EXPOSE 3000

# Default CMD (Coolify will override this for the worker service with 'npm run start:worker')
CMD ["npm", "run", "start:web"]
