#!/bin/bash
# MJ Bot Deploy Script

set -e
REPO="https://raw.githubusercontent.com/Greentruthnyc420/mj-bot-deploy/main"

# Auto-detect bot directory
if [ -d "/opt/mj-bot" ]; then
    BOT_DIR="/opt/mj-bot"
elif [ -d "$HOME/chronic-coder" ]; then
    BOT_DIR="$HOME/chronic-coder"
else
    echo "ERROR: Cannot find bot directory!"
    exit 1
fi

echo "=== MJ Bot Deploy ==="
echo "Bot dir: $BOT_DIR"

# Download updated files
echo "Downloading config.js..."
curl -sL "$REPO/src/config.js" -o "$BOT_DIR/src/config.js"
echo "OK"

echo "Downloading claude.js..."
curl -sL "$REPO/src/brain/claude.js" -o "$BOT_DIR/src/brain/claude.js"
echo "OK"

echo "Downloading .env..."
curl -sL "$REPO/.env" -o "$BOT_DIR/.env"
echo "OK"

# Restart bot - try docker first, then direct node
echo "Restarting bot..."
if command -v docker &>/dev/null && docker ps -q --filter name=mj-bot 2>/dev/null | grep -q .; then
    echo "Restarting Docker container..."
    docker restart mj-bot
    sleep 3
    docker logs --tail 20 mj-bot
else
    echo "Restarting node process..."
    cd $BOT_DIR
    PID=$(ps aux | grep "node src/index.js" | grep -v grep | awk '{print $2}')
    if [ ! -z "$PID" ]; then
        kill $PID 2>/dev/null || true
        sleep 2
    fi
    nohup npm start > ~/mary-jane.log 2>&1 &
    sleep 3
    NEW_PID=$(ps aux | grep "node src/index.js" | grep -v grep | awk '{print $2}')
    if [ ! -z "$NEW_PID" ]; then
        echo "Bot started! PID: $NEW_PID"
    else
        echo "ERROR: Bot did not start. Check: tail -f ~/mary-jane.log"
        tail -20 ~/mary-jane.log 2>/dev/null || true
        exit 1
    fi
fi

echo "=== Deploy complete ==="
echo "Check logs: tail -f ~/mary-jane.log (or: docker logs -f mj-bot)"
