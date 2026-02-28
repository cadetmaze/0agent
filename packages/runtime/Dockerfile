# ============================================================
# Only Reason — TypeScript Runtime Dockerfile
# ============================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN npx tsc

# ============================================================
# Production stage
# ============================================================
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json ./
RUN npm install --production

# Copy built files
COPY --from=builder /app/dist ./dist

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
