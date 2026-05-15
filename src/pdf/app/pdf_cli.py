from __future__ import annotations

import argparse
from typing import List

from app.pdf_page_selection import parse_pages
from services.pdf_services import (
    extract_pdf_blocks,
    fill_translated_pdf,
    strip_pdf_text,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Wasabi PDF extraction/backfill helper"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    extract_parser = subparsers.add_parser(
        "extract", help="extract PDF text blocks to JSON"
    )
    extract_parser.add_argument("input_pdf")
    extract_parser.add_argument("output_json")
    extract_parser.add_argument("--pages", type=parse_pages, default=None)

    strip_parser = subparsers.add_parser(
        "strip",
        help="strip safe text objects from PDF while preserving original graphics",
    )
    strip_parser.add_argument("input_pdf")
    strip_parser.add_argument("output_pdf")
    strip_parser.add_argument("--pages", type=parse_pages, default=None)

    fill_parser = subparsers.add_parser(
        "fill", help="fill translated JSON text back into PDF"
    )
    fill_parser.add_argument("input_pdf")
    fill_parser.add_argument("translated_json")
    fill_parser.add_argument("output_pdf")

    return parser


def main(argv: List[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "extract":
        extract_pdf_blocks(args.input_pdf, args.output_json, args.pages)
    elif args.command == "strip":
        stats = strip_pdf_text(args.input_pdf, args.output_pdf, args.pages)
        print(
            f"Stripped PDF text: {args.output_pdf} "
            f"(pages={stats.pages}, streams={stats.streams}, "
            f"removed_text_objects={stats.removed_text_objects}, "
            f"retained_risky_text_objects={stats.retained_risky_text_objects}, "
            f"retained_unterminated_text_objects={stats.retained_unterminated_text_objects}, "
            f"forms={stats.forms})"
        )
    elif args.command == "fill":
        fill_translated_pdf(args.input_pdf, args.translated_json, args.output_pdf)
    return 0
