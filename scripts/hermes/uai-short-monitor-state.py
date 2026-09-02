#!/usr/bin/env python3
"""Stable state-signature entry point for Hermes Cron monitoring."""
from uai_short_monitor import main


if __name__ == "__main__":
    raise SystemExit(main(["--state"]))
