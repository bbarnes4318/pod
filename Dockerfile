# Stage 1: Build dependency and app build
FROM node:20-slim AS builder
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate

# One identifier per image, read by BOTH the build and the running server.
#
# `next start` re-reads next.config at runtime, so if the server resolved a
# different deploymentId than the one compiled into the assets it would report a
# mismatch on every single request and reload the page forever. Writing the
# value to a file the runner stage copies is what keeps the two in agreement.
#
# .git is dockerignored, so there is no commit SHA to read in here. Coolify's
# SOURCE_COMMIT is used when it supplies one; the timestamp fallback only has to
# be distinct per build, which it is. Replicas of one deploy share the image, so
# they share the id — which is the case that matters behind a load balancer.
ARG SOURCE_COMMIT=""
RUN NEXT_DEPLOYMENT_ID="${SOURCE_COMMIT:-build-$(date +%s)}" \
 && printf '%s' "$NEXT_DEPLOYMENT_ID" > /app/.deployment-id \
 && NEXT_DEPLOYMENT_ID="$NEXT_DEPLOYMENT_ID" npm run build

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
# next start reads next.config at RUNTIME — without this file in the runner
# stage, every custom setting (e.g. serverActions.bodySizeLimit for asset
# uploads) silently reverts to Next defaults.
COPY --from=builder /app/next.config.ts ./next.config.ts
# The id the assets in .next were stamped with; the server must advertise this
# exact value or the skew check compares two unrelated strings.
COPY --from=builder /app/.deployment-id ./.deployment-id

EXPOSE 3000

# Default CMD (Coolify will override this for the worker service with 'npm run start:worker')
CMD ["sh", "-c", "NEXT_DEPLOYMENT_ID=\"$(cat .deployment-id)\" npm run start:web"]
