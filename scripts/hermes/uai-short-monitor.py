#!/usr/bin/env python3
"""Cron/detail entry point for the UAIUSDT monitor."""
from uai_short_monitor import main


if __name__ == "__main__":
    raise SystemExit(main(["--detail"]))
