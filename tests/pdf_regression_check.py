from __future__ import annotations

import argparse
import pathlib
import sys
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
PDF_SRC = REPO_ROOT / "src" / "pdf"
sys.path.insert(0, str(PDF_SRC))

from app.pdf_cli import build_parser  # noqa: E402
from app.pdf_page_selection import parse_pages  # noqa: E402
from domain import common, layout, preservation, rendering  # noqa: E402
from services import pdf_extract_impl, pdf_fill_impl, pdf_services, pdf_strip_impl  # noqa: E402


class PageSelectionTests(unittest.TestCase):
    def test_parse_pages_single_and_range(self) -> None:
        self.assertEqual(parse_pages("1,3,5"), [1, 3, 5])
        self.assertEqual(parse_pages("2-4,7"), [2, 3, 4, 7])

    def test_parse_pages_deduplicates_and_sorts(self) -> None:
        self.assertEqual(parse_pages("4,2-3,3,2"), [2, 3, 4])

    def test_parse_pages_rejects_invalid_input(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_pages("")
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_pages("0")
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_pages("4-2")
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_pages("a,b")


class CliTests(unittest.TestCase):
    def test_build_parser_extract(self) -> None:
        parser = build_parser()
        args = parser.parse_args(["extract", "input.pdf", "blocks.json", "--pages", "1-2"])
        self.assertEqual(args.command, "extract")
        self.assertEqual(args.input_pdf, "input.pdf")
        self.assertEqual(args.output_json, "blocks.json")
        self.assertEqual(args.pages, [1, 2])

    def test_build_parser_fill(self) -> None:
        parser = build_parser()
        args = parser.parse_args(["fill", "input.pdf", "translated.json", "output.pdf"])
        self.assertEqual(args.command, "fill")
        self.assertEqual(args.input_pdf, "input.pdf")
        self.assertEqual(args.translated_json, "translated.json")
        self.assertEqual(args.output_pdf, "output.pdf")


class StructureTests(unittest.TestCase):
    def test_domain_exports_are_importable(self) -> None:
        self.assertTrue(callable(common.normalize_text))
        self.assertTrue(callable(layout.resolve_layout_intent))
        self.assertTrue(callable(preservation.detect_scored_table_regions))
        self.assertTrue(callable(rendering.write_translated_block))

    def test_service_exports_are_importable(self) -> None:
        self.assertTrue(callable(pdf_services.extract_pdf_blocks))
        self.assertTrue(callable(pdf_services.strip_pdf_text))
        self.assertTrue(callable(pdf_services.fill_translated_pdf))
        self.assertTrue(callable(pdf_extract_impl.extract_blocks))
        self.assertTrue(callable(pdf_strip_impl.strip_text_from_pdf))
        self.assertTrue(callable(pdf_fill_impl.fill_pdf_preserving_graphics))

    def test_common_helpers_basic_behavior(self) -> None:
        self.assertEqual(common.normalize_text(" a \n  b\tc "), "a b c")
        self.assertEqual(common.sanitize_translated_text("<pad> hello </pad>"), "hello")
        self.assertEqual(common.direction_to_rotation((1.0, 0.0)), 0)


if __name__ == "__main__":
    unittest.main()
