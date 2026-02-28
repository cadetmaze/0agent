#!/usr/bin/env bash
# =============================================================================
# 0agent — One command to start everything
#
# Usage: ./start.sh
#
# What it does:
#   1. Checks prerequisites (Node 20+, Docker, npm)
#   2. Installs CLI dependencies if needed
#   3. Runs the onboard wizard if not already configured
#   4. Starts the infrastructure (docker compose up)
#   5. Streams logs in the foreground
#   6. Ctrl+C gracefully shuts down containers (data is preserved)
#
# Data persistence:
#   Postgres data lives in a Docker volume — your agent's memory,
#   telemetry, and task history survive restarts.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$SCRIPT_DIR/packages/cli"
CONFIG_DIR="$HOME/.0agent"
ENV_FILE="$CONFIG_DIR/.env"
COMPOSE_FILE="$SCRIPT_DIR/infra/docker-compose.yml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ─────────────────────────────────────────────
# Graceful shutdown on Ctrl+C
# ─────────────────────────────────────────────

cleanup() {
    echo ""
    echo -e "${YELLOW}  Shutting down gracefully...${RESET}"
    if [ -f "$COMPOSE_FILE" ] && [ -f "$ENV_FILE" ]; then
        # Stop containers but keep volumes (preserves memory/data)
        docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down 2>/dev/null || true
    fi
    echo -e "${GREEN}  ✓ Stopped.${RESET} Your agent's memory is preserved — run ${CYAN}./start.sh${RESET} to resume."
    echo ""
    exit 0
}

trap cleanup SIGINT SIGTERM

echo ""
echo -e "${BOLD}${CYAN}  ⬡ 0agent${RESET}"
echo -e "${DIM}  ─────────────────────────────────${RESET}"
echo ""

# ─────────────────────────────────────────────
# Step 1: Prerequisites
# ─────────────────────────────────────────────

FAIL=0

# Node.js 20+
if command -v node &>/dev/null; then
    NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
    if [ "$NODE_MAJOR" -lt 20 ]; then
        echo -e "${RED}  ✗ Node.js 20+ required (you have $(node -v))${RESET}"
        echo -e "    Install: ${CYAN}https://nodejs.org${RESET} or ${CYAN}nvm install 22${RESET}"
        FAIL=1
    else
        echo -e "${GREEN}  ✓${RESET} Node.js $(node -v)"
    fi
else
    echo -e "${RED}  ✗ Node.js not found${RESET}"
    echo -e "    Install: ${CYAN}https://nodejs.org${RESET}"
    FAIL=1
fi

# Docker
if command -v docker &>/dev/null && docker info &>/dev/null; then
    echo -e "${GREEN}  ✓${RESET} Docker"
else
    echo -e "${RED}  ✗ Docker is not running${RESET}"
    echo -e "    Install: ${CYAN}https://docs.docker.com/get-docker/${RESET}"
    echo -e "    Then start Docker Desktop and try again."
    FAIL=1
fi

# npm
if command -v npm &>/dev/null; then
    echo -e "${GREEN}  ✓${RESET} npm $(npm -v 2>/dev/null)"
else
    echo -e "${RED}  ✗ npm not found${RESET}"
    echo -e "    Install Node.js from ${CYAN}https://nodejs.org${RESET} (npm is included)."
    FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
    echo ""
    echo -e "${RED}  Fix the issues above and run: ./start.sh${RESET}"
    echo ""
    exit 1
fi

echo ""

# ─────────────────────────────────────────────
# Step 2: Install CLI dependencies
# ─────────────────────────────────────────────

if [ ! -d "$CLI_DIR/node_modules" ]; then
    echo -e "${DIM}  Installing CLI dependencies...${RESET}"
    (cd "$CLI_DIR" && npm install --silent 2>/dev/null)
    echo -e "${GREEN}  ✓${RESET} Dependencies installed"
    echo ""
fi

# ─────────────────────────────────────────────
# Step 3: Run onboard if not configured
# ─────────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
    echo -e "${BOLD}  First run — starting setup wizard${RESET}"
    echo ""
    (cd "$CLI_DIR" && npx tsx src/cli/index.ts onboard)
    # If onboard didn't create the env file, exit
    if [ ! -f "$ENV_FILE" ]; then
        echo -e "${RED}  Setup was not completed. Run ./start.sh again.${RESET}"
        exit 1
    fi
else
    echo -e "${GREEN}  ✓${RESET} Config loaded from ${DIM}$CONFIG_DIR${RESET}"
fi

# ─────────────────────────────────────────────
# Step 4: Start infrastructure
# ─────────────────────────────────────────────

if [ ! -f "$COMPOSE_FILE" ]; then
    echo -e "${RED}  ✗ docker-compose.yml not found at $COMPOSE_FILE${RESET}"
    exit 1
fi

echo -e "${DIM}  Starting infrastructure...${RESET}"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build postgres redis runtime 2>/dev/null

# Wait for runtime health
echo -e "${DIM}  Waiting for runtime...${RESET}"
MAX_WAIT=90
ELAPSED=0
HEALTHY=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
    if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
        HEALTHY=1
        break
    fi
    sleep 3
    ELAPSED=$((ELAPSED + 3))
done

if [ "$HEALTHY" -eq 1 ]; then
    echo -e "${GREEN}  ✓${RESET} All services healthy"
else
    echo -e "${YELLOW}  ⚠ Runtime not healthy yet — check logs below${RESET}"
fi

echo ""
echo -e "${BOLD}${GREEN}  ⬡ 0agent is running${RESET}"
echo ""
echo -e "  ${CYAN}Task:${RESET}      cd packages/cli && npx tsx src/cli/index.ts task \"...\""
echo -e "  ${CYAN}Telegram:${RESET}  cd packages/cli && npx tsx src/cli/index.ts telegram"
echo -e "  ${CYAN}Status:${RESET}    cd packages/cli && npx tsx src/cli/index.ts status"
echo ""
echo -e "${DIM}  Streaming logs below. Press Ctrl+C to stop (memory is preserved).${RESET}"
echo -e "${DIM}  ─────────────────────────────────${RESET}"
echo ""

# ─────────────────────────────────────────────
# Step 5: Stream logs in foreground
# Ctrl+C triggers the cleanup trap above
# ─────────────────────────────────────────────

docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs -f postgres redis runtime 2>/dev/null
