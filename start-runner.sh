#!/usr/bin/env bash
# Waits for the discovery run (if given a PID) and then starts the sequential phase runner.
cd /workspace/shark-fitness-orchestration
if [ -n "$1" ]; then while kill -0 "$1" 2>/dev/null; do sleep 30; done; fi
if [ ! -s phases.json ]; then echo "[$(date)] phases.json missing; discovery failed" >> logs/runner.log; exit 1; fi
exec flock -n /tmp/shark-runner.lock python3 runner.py >> logs/runner.out 2>&1
