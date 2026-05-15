#!/usr/bin/env python3
"""Thin CLI entrypoint for Wasabi PDF extraction/backfill."""

from __future__ import annotations

import sys

from app.pdf_cli import main


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
