#!/bin/bash
# MJ Bot Deploy Script - Run on server
# Usage: curl -sL https://raw.githubusercontent.com/Greentruthnyc420/mj-bot-deploy/main/deploy.sh | bash

set -e
BOT_DIR="$HOME/chronic-coder"
REPO="https://raw.githubusercontent.com/Greentruthnyc420/mj-bot-deploy/main"

echo '=== MJ Bot Deploy ==='
echo "Bot dir: $BOT_DIR"

# Download updated files
echo 'Downloading config.js...'
curl -sL "$REPO/src/config.js" -o "$BOT_DIR/src/config.js"
echo 'OK'

echo 'Downloading claude.js...'
curl -sL "$REPO/src/brain/claude.js" -o "$BOT_DIR/src/brain/claude.js"
echo 'OK'

echo 'Downloading .env...'
curl -sL "$REPO/.env" -o "$BOT_DIR/.env"
echo 'OK'

# Restart bot
echo 'Restarting bot...'
cd $BOT_DIR
bash restart-bot.sh

echo '=== Deploy complete ==='
echo 'Check logs: tail -f ~/mary-jane.log'
