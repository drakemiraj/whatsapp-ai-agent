#!/bin/bash
termux-wake-lock 2>/dev/null
echo "=========================================================="
echo "?? DARKEMI DIGITAL AGENCY ? 24/7 UNSTOPPABLE MASTER AGENT"
echo "?? Auto-WakeLock Active | Heartbeat Watchdog Running"
echo "=========================================================="
while true; do
  node bot-baileys.js
  EXIT_CODE=$?
  echo "?? Process exited (Code: $EXIT_CODE). Restarting in 2 seconds..."
  sleep 2
done