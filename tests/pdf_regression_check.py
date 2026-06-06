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
        byline_block = {
            "text": "Heidi Ledford writes for Nature from Boston, Massachusetts.",
            "blockType": "metadata",
            "layoutLines": [
                {
                    "items": [
                        {"type": "text", "text": "Heidi Ledford", "isBoldLike": True},
                        {"type": "text", "text": " writes for ", "isItalicLike": True},
                        {"type": "text", "text": "Nature", "isItalicLike": False},
                        {"type": "text", "text": " from Boston, ", "isItalicLike": True},
                    ]
                },
                {
                    "items": [
                        {"type": "text", "text": "Massachusetts.", "isItalicLike": True},
                    ]
                },
            ],
        }
        self.assertTrue(common.is_short_byline_metadata_block(byline_block))
        byline_block_for_wrap = {
            **byline_block,
            "bbox": [267.8739929199219, 727.160400390625, 432.8182678222656, 750.2061157226562],
            "wrapLineTemplates": [
                {"xOffset": 0, "width": 164.94427490234375},
                {"xOffset": 0, "width": 53.370758056640625},
            ],
            "layoutIntent": "structured_fields",
            "role": "paragraph",
        }
        fitz = common.require_fitz()
        font_options = rendering.resolve_font_options(
            "Heidi Ledford writes for Nature from Boston, Massachusetts.",
            bold=False,
            font_role="metadata",
            preferred_style="normal",
            family_class="serif",
        )
        measure_font = rendering.create_measure_font(fitz, font_options)
        wrapped = common.wrap_text_by_source_line_breaks(
            "Heidi Ledford writes for Nature from Boston, Massachusetts.",
            byline_block_for_wrap,
            fitz.Rect(*byline_block_for_wrap["bbox"]),
            9.3,
            measure_font,
        )
        self.assertNotIn("\n,", wrapped)

    def test_mixed_style_metadata_layout_returns(self) -> None:
        block = {
            "bbox": [267.8739929199219, 727.160400390625, 432.8182678222656, 750.2061157226562],
            "fontSize": 9.3,
            "rotation": 0,
            "role": "paragraph",
            "blockType": "metadata",
            "layoutIntent": "structured_fields",
            "preferredTextStyle": "normal",
            "styleFamilyClass": "serif",
            "wrapLineTemplates": [
                {"xOffset": 0, "width": 164.94427490234375},
                {"xOffset": 0, "width": 53.370758056640625},
            ],
            "layoutLines": [
                {
                    "bbox": [267.8739929199219, 727.160400390625, 432.8182678222656, 739.7061157226562],
                    "items": [
                        {
                            "type": "text",
                            "text": "Heidi Ledford",
                            "bbox": [267.8739929199219, 727.8300170898438, 321.8232421875, 739.7061157226562],
                            "font": "MinionPro-Bold",
                            "size": 9.300000190734863,
                            "color": [0.13725490196078433, 0.12156862745098039, 0.12549019607843137],
                            "flags": 20,
                            "isBoldLike": True,
                        },
                        {
                            "type": "text",
                            "text": " writes for ",
                            "bbox": [321.7724914550781, 727.8114013671875, 358.69256591796875, 739.7061157226562],
                            "font": "MinionPro-It",
                            "size": 9.300000190734863,
                            "color": [0.13725490196078433, 0.12156862745098039, 0.12549019607843137],
                            "flags": 6,
                            "isItalicLike": True,
                        },
                        {
                            "type": "text",
                            "text": "Nature",
                            "bbox": [358.2239990234375, 727.160400390625, 383.529296875, 739.7061157226562],
                            "font": "MinionPro-Regular",
                            "size": 9.300000190734863,
                            "color": [0.13725490196078433, 0.12156862745098039, 0.12549019607843137],
                            "flags": 4,
                        },
                        {
                            "type": "text",
                            "text": " from Boston, ",
                            "bbox": [383.4826965332031, 727.8114013671875, 432.8182678222656, 739.7061157226562],
                            "font": "MinionPro-It",
                            "size": 9.300000190734863,
                            "color": [0.13725490196078433, 0.12156862745098039, 0.12549019607843137],
                            "flags": 6,
                            "isItalicLike": True,
                        },
                    ],
                },
                {
                    "bbox": [267.8739929199219, 738.3114013671875, 321.2447509765625, 750.2061157226562],
                    "items": [
                        {
                            "type": "text",
                            "text": "Massachusetts.",
                            "bbox": [267.8739929199219, 738.3114013671875, 321.2447509765625, 750.2061157226562],
                            "font": "MinionPro-It",
                            "size": 9.300000190734863,
                            "color": [0.13725490196078433, 0.12156862745098039, 0.12549019607843137],
                            "flags": 6,
                            "isItalicLike": True,
                        },
                    ],
                },
            ],
        }
        self.assertTrue(common.has_pathological_narrow_tail_template(block))
        self.assertFalse(common.should_preserve_source_line_breaks(block, "metadata"))

    def test_journal_footer_metadata_block_is_preserved(self) -> None:
        block = {
            "id": "p4_b18",
            "page": 4,
            "bbox": [213.2615966796875, 760.638671875, 558.42919921875, 768.6607055664062],
            "pageHeight": 782.3619995117188,
            "text": "C O R R E C T E D 2 1 S E P T E M B E R 2 0 1 5 | 1 7 S E P T E M B E R 2 0 1 5 | V O L 5 2 5 | N A T U R E | 3 1 1",
        }
        self.assertTrue(preservation.is_journal_footer_metadata_block(block))

    def test_decorative_picture_region_builds_preserved_region(self) -> None:
        pages_blocks = [[
            {
                "id": "p2_b21",
                "page": 2,
                "preserveOriginal": True,
                "preserveReason": "picture_region",
                "bbox": [487.22808837890625, 22.622509002685547, 553.800048828125, 37.09457015991211],
                "pageWidth": 595.2760009765625,
                "pageHeight": 782.3619995117188,
            }
        ]]
        regions = pdf_fill_impl._build_preserved_decorative_picture_regions_by_page(pages_blocks)
        self.assertEqual(len(regions), 1)
        self.assertEqual(len(regions[0]), 1)
        self.assertLess(regions[0][0][0], 487.22808837890625)
        self.assertGreater(regions[0][0][2], 553.800048828125)

    def test_page_has_preserved_text_regions(self) -> None:
        self.assertTrue(pdf_fill_impl._page_has_preserved_text_regions(0, [[[1, 2, 3, 4]]]))
        self.assertFalse(pdf_fill_impl._page_has_preserved_text_regions(1, [[[1, 2, 3, 4]]]))
        self.assertFalse(pdf_fill_impl._page_has_preserved_text_regions(0, [[]]))

    def test_preserve_mode_for_block_uses_image_for_complex_picture_region(self) -> None:
        complex_picture = {
            "page": 2,
            "preserveOriginal": True,
            "preserveReason": "picture_region",
            "bbox": [226.9, 704.1, 309.0, 743.5],
        }
        decorative_picture = {
            "page": 2,
            "preserveOriginal": True,
            "preserveReason": "picture_region",
            "bbox": [487.2, 22.6, 553.8, 37.1],
        }
        decorative_regions_by_page = [
            [],
            [[484.2, 19.6, 556.8, 40.1]],
        ]
        self.assertEqual(
            pdf_fill_impl._preserve_mode_for_block(complex_picture, decorative_regions_by_page),
            "image",
        )
        self.assertEqual(
            pdf_fill_impl._preserve_mode_for_block(decorative_picture, decorative_regions_by_page),
            "pdf",
        )

    def test_preserved_xobject_names_by_page_collects_anchor_names(self) -> None:
        pages_blocks = [[
            {
                "preserveAnchors": {
                    "xobjects": [
                        {"name": "/X1", "subtype": "/Form"},
                        {"name": "/X4", "subtype": "/Image"},
                    ]
                }
            },
            {
                "preserveAnchors": {
                    "xobjects": [
                        {"name": "/X1", "subtype": "/Form"},
                    ]
                }
            },
        ]]
        self.assertEqual(pdf_fill_impl._preserved_xobject_names_by_page(pages_blocks), [{"/X1", "/X4"}])


if __name__ == "__main__":
    unittest.main()
