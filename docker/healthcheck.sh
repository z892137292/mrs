#!/usr/bin/env sh
# Healthy while the scheduler is alive. A paused (STOP) state is still "healthy":
# the container works as designed; inspect it with `rewards-ctl status`.
pgrep -x supercronic >/dev/null 2>&1
