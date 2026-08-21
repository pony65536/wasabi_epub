import json
import sys
import unittest
from pathlib import Path
from copy import deepcopy


REPO_ROOT = Path(__file__).resolve().parents[1]
PDF_SRC = REPO_ROOT / "src" / "pdf"
if str(PDF_SRC) not in sys.path:
    sys.path.insert(0, str(PDF_SRC))

from domain import core, preservation, rendering  # noqa: E402
from services.pdf_extract_impl import (  # noqa: E402
    _promote_composite_symbol_candidate_blocks,
    _promote_monospace_parameter_blocks,
    _promote_small_superscript_tick_labels,
    _promote_table_headers,
)
from services.pdf_fill_impl import resolve_block_action  # noqa: E402
import detect_tables  # noqa: E402


class FormulaHeuristicsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cache_path = REPO_ROOT / ".cache_2605.08083v1_pdf" / "pdf_blocks_translated.json"
        cls.cache_payload = json.loads(cls.cache_path.read_text(encoding="utf-8"))
        cls.paper_table_detection = json.loads(
            (REPO_ROOT / "output" / "2605.08083v1_tables_from_pdf.json").read_text(encoding="utf-8")
        )
        cls.transformer_table_detection = json.loads(
            (REPO_ROOT / "output" / "1706.03762v7_tables.json").read_text(encoding="utf-8")
        )
        cls.fbmap_table_detection = json.loads(
            (REPO_ROOT / "output" / "Functional_Brain_Mapping_and_Its_Applica_tables_latest.json").read_text(encoding="utf-8")
        )
        cls.nihms_table_detection = json.loads(
            (REPO_ROOT / "output" / "nihms-984751_tables_latest.json").read_text(encoding="utf-8")
        )
        cls.p2_b2 = next(block for block in cls.cache_payload["blocks"] if block.get("id") == "p2_b2")
        cls.page6_blocks = [deepcopy(block) for block in cls.cache_payload["blocks"] if block.get("page") == 6]
        cls.page7_blocks = [deepcopy(block) for block in cls.cache_payload["blocks"] if block.get("page") == 7]
        cls.page8_blocks = [deepcopy(block) for block in cls.cache_payload["blocks"] if block.get("page") == 8]
        cls.page19_blocks = [deepcopy(block) for block in cls.cache_payload["blocks"] if block.get("page") == 19]
        cls.page17_blocks = [deepcopy(block) for block in cls.cache_payload["blocks"] if block.get("page") == 17]
        cls.p2_b3 = next(block for block in cls.cache_payload["blocks"] if block.get("id") == "p2_b3")
        cls.p7_b12 = next(block for block in cls.cache_payload["blocks"] if block.get("id") == "p7_b12")

    def _find_item(self, target_text: str):
        for line in self.p2_b2.get("layoutLines") or []:
            for item in line.get("items", []) or []:
                if item.get("text") == target_text:
                    return item
        self.fail(f"item not found: {target_text}")

    @staticmethod
    def _find_detected_page(detection_payload, page_no: int):
        return next((page for page in detection_payload.get("pages", []) if page.get("page") == page_no), None)

    def test_short_latin_fragments_are_not_formula_spans(self):
        for token in ("ROBE", "O"):
            item = self._find_item(token)
            self.assertFalse(core.is_formula_span(item, float(self.p2_b2.get("fontSize") or 10.0)), token)

    def test_span_formula_examples(self):
        negatives = [
            {"text": "ROBE", "font": "NimbusRomNo9L-Regu", "size": 8.0, "flags": 4},
            {"text": "O", "font": "NimbusRomNo9L-Regu", "size": 8.0, "flags": 4},
            {"text": "IEEE", "font": "NimbusRomNo9L-Regu", "size": 8.0, "flags": 4},
            {"text": "TABLE", "font": "NimbusRomNo9L-Regu", "size": 8.0, "flags": 4},
            {"text": "Fig", "font": "NimbusRomNo9L-Regu", "size": 8.0, "flags": 4},
            {"text": "et", "font": "NimbusRomNo9L-Regu", "size": 8.0, "flags": 6},
            {"text": "al", "font": "NimbusRomNo9L-Regu", "size": 8.0, "flags": 6},
            {"text": "A", "font": "NimbusRomNo9L-Regu", "size": 8.0, "flags": 4},
            {"text": "1", "font": "NimbusRomNo9L-Regu", "size": 8.0, "flags": 1},
        ]
        positives = [
            {"text": "α", "font": "NimbusRomNo9L-Regu", "size": 10.0, "flags": 4},
            {"text": "β", "font": "NimbusRomNo9L-Regu", "size": 10.0, "flags": 4},
            {"text": "x_i", "font": "NimbusRomNo9L-Regu", "size": 10.0, "flags": 4},
            {"text": "x^2", "font": "NimbusRomNo9L-Regu", "size": 10.0, "flags": 4},
            {"text": "O(n)", "font": "NimbusRomNo9L-Regu", "size": 10.0, "flags": 4},
            {"text": "sin(x)", "font": "NimbusRomNo9L-Regu", "size": 10.0, "flags": 4},
            {"text": "∑", "font": "NimbusRomNo9L-Regu", "size": 10.0, "flags": 4},
            {"text": "x ≤ y", "font": "NimbusRomNo9L-Regu", "size": 10.0, "flags": 4},
            {"text": "10⁻³", "font": "NimbusRomNo9L-Regu", "size": 10.0, "flags": 4},
        ]

        for span in negatives:
            self.assertFalse(core.is_formula_span(span, 10.0), span["text"])
        for span in positives:
            self.assertTrue(core.is_formula_span(span, 10.0), span["text"])

    def test_p2_b2_stays_translatable_under_current_block_logic(self):
        rebuilt_lines = []
        for line in self.p2_b2.get("layoutLines") or []:
            rebuilt_items = []
            for item in line.get("items", []) or []:
                item_type = "formula" if core.is_formula_span(item, float(self.p2_b2.get("fontSize") or 10.0)) else "text"
                rebuilt_items.append({**item, "type": item_type})
            rebuilt_lines.append({**line, "items": core.merge_span_items(rebuilt_items)})

        rebuilt_block = dict(self.p2_b2)
        rebuilt_block["layoutLines"] = rebuilt_lines
        rebuilt_block["text"] = self.p2_b2.get("text") or ""

        self.assertFalse(core.is_display_formula_block(rebuilt_block))
        self.assertFalse(core.is_formula_heavy_text(rebuilt_block["text"]))
        self.assertNotEqual(rebuilt_block.get("blockType"), "formula_display")
        self.assertIsNot(rebuilt_block.get("preserveOriginal"), True)

    def test_p6_b1_is_promoted_to_table_header_during_extraction(self):
        page_blocks = deepcopy(self.page6_blocks)
        _promote_table_headers(page_blocks, 612.0)
        block = next(item for item in page_blocks if item.get("id") == "p6_b1")
        self.assertEqual(block.get("blockType"), "table_header")
        self.assertIs(block.get("preserveOriginal"), True)
        self.assertEqual(resolve_block_action(block), "preserve")

    def test_page7_superscript_tick_labels_are_preserved_during_extraction(self):
        page_blocks = deepcopy(self.page7_blocks)
        _promote_small_superscript_tick_labels(page_blocks)
        for block_id in ("p7_b0", "p7_b11", "p7_b21", "p7_b31"):
            block = next(item for item in page_blocks if item.get("id") == block_id)
            self.assertEqual(block.get("blockType"), "other")
            self.assertIs(block.get("preserveOriginal"), True)
            self.assertEqual(block.get("preserveReason"), "figure_tick_label")
            self.assertEqual(resolve_block_action(block), "preserve")

    def test_page8_scientific_tick_labels_are_preserved_during_extraction(self):
        page_blocks = deepcopy(self.page8_blocks)
        _promote_small_superscript_tick_labels(page_blocks)
        for block_id in ("p8_b0", "p8_b13", "p8_b25", "p8_b37"):
            block = next(item for item in page_blocks if item.get("id") == block_id)
            self.assertEqual(block.get("blockType"), "other")
            self.assertIs(block.get("preserveOriginal"), True)
            self.assertEqual(block.get("preserveReason"), "figure_tick_label")
            self.assertEqual(resolve_block_action(block), "preserve")

    def test_page19_monospace_parameter_blocks_are_preserved_during_extraction(self):
        page_blocks = deepcopy(self.page19_blocks)
        _promote_monospace_parameter_blocks(page_blocks)
        for block_id in ("p19_b9", "p19_b10", "p19_b12"):
            block = next(item for item in page_blocks if item.get("id") == block_id)
            self.assertEqual(block.get("blockType"), "code")
            self.assertIs(block.get("preserveOriginal"), True)
            self.assertEqual(block.get("preserveReason"), "code_block")
            self.assertEqual(resolve_block_action(block), "preserve")

    def test_composite_symbol_margin_blocks_are_preserved_during_extraction(self):
        page_blocks = deepcopy(self.page17_blocks)
        _promote_composite_symbol_candidate_blocks(page_blocks)
        block = next(item for item in page_blocks if item.get("id") == "p17_b3")
        self.assertEqual(block.get("blockType"), "other")
        self.assertIs(block.get("preserveOriginal"), True)
        self.assertEqual(block.get("preserveReason"), "composite_math_symbol")
        self.assertIsInstance(block.get("compositeSymbolCandidates"), list)
        self.assertGreaterEqual(len(block["compositeSymbolCandidates"]), 2)
        first = block["compositeSymbolCandidates"][0]
        self.assertEqual(first.get("type"), "composite_math_symbol")
        self.assertIsNone(first.get("semanticText"))
        self.assertEqual(first.get("renderPolicy"), "preserve_visual")
        self.assertEqual(resolve_block_action(block), "preserve")

    def test_helvetica_font_aliases_use_valid_pymupdf_names(self):
        self.assertEqual(
            core.resolve_latin_font_by_family("helv", bold=False, preferred_style="normal"),
            {"fontname": "helv"},
        )
        self.assertEqual(
            core.resolve_latin_font_by_family("helv", bold=True, preferred_style="bold"),
            {"fontname": "hebo"},
        )
        self.assertEqual(
            core.resolve_latin_font_by_family("helv", bold=False, preferred_style="italic"),
            {"fontname": "heit"},
        )
        self.assertEqual(
            core.resolve_latin_font_by_family("helv", bold=True, preferred_style="bold_italic"),
            {"fontname": "hebi"},
        )

    def test_caption_does_not_preserve_source_line_breaks(self):
        block = {
            "blockType": "caption",
            "layoutLines": [
                {"bbox": [0, 0, 120, 10], "items": [{"text": "Figure 1:", "type": "text"}]},
                {"bbox": [0, 12, 120, 22], "items": [{"text": "Existing TTS algorithms", "type": "text"}]},
            ],
        }
        self.assertFalse(core.should_preserve_source_line_breaks(block, "caption"))

    def test_body_and_caption_use_full_bbox_reflow_path(self):
        body_block = {"blockType": "body"}
        caption_block = {"blockType": "caption"}
        code_block = {"blockType": "code"}
        self.assertTrue(rendering.should_use_full_bbox_reflow(body_block))
        self.assertTrue(rendering.should_use_full_bbox_reflow(caption_block))
        self.assertFalse(rendering.should_use_full_bbox_reflow(code_block))

    def test_caption_render_policy_defaults_to_plain_reflow(self):
        block = {
            "blockType": "caption",
            "layoutLines": [
                {"items": [{"text": "Figure 1:", "type": "text"}]},
                {"items": [{"text": "Existing TTS algorithms as special cases.", "type": "text"}]},
            ],
            "bbox": [0, 0, 320, 42],
        }
        self.assertEqual(rendering.resolve_caption_render_policy(block), "plain_reflow")
        self.assertEqual(rendering.resolve_render_policy(block), "plain_reflow")

    def test_caption_render_policy_uses_mixed_reflow_for_style_anchors(self):
        block = {
            "blockType": "caption",
            "layoutLines": [
                {
                    "items": [
                        {"text": "Figure 1:", "type": "text", "isBoldLike": True},
                        {"text": " Existing TTS algorithms.", "type": "text"},
                    ]
                }
            ],
            "bbox": [0, 0, 320, 18],
        }
        self.assertEqual(rendering.resolve_caption_render_policy(block), "mixed_reflow")

    def test_caption_with_formula_still_defaults_to_reflow(self):
        block = {
            "blockType": "caption",
            "layoutLines": [
                {"items": [{"text": "Figure 2:", "type": "text"}]},
                {"items": [{"text": "x_i", "type": "formula"}]},
            ],
            "bbox": [0, 0, 180, 60],
        }
        self.assertEqual(rendering.resolve_caption_render_policy(block), "plain_reflow")

    def test_caption_render_policy_preserves_disconnected_visual_layout(self):
        block = {
            "blockType": "caption",
            "layoutLines": [
                {"bbox": [0, 0, 60, 12], "items": [{"text": "(a)", "type": "text"}]},
                {"bbox": [90, 14, 150, 26], "items": [{"text": "(b)", "type": "text"}]},
                {"bbox": [180, 28, 240, 40], "items": [{"text": "(c)", "type": "text"}]},
            ],
            "bbox": [0, 0, 260, 44],
        }
        self.assertEqual(rendering.resolve_caption_render_policy(block), "preserve_visual")

    def test_metadata_uses_body_reflow_path(self):
        block = deepcopy(self.p2_b3)
        self.assertEqual(block.get("blockType"), "metadata")
        self.assertEqual(block.get("layoutIntent"), "structured_fields")
        self.assertTrue(core.should_use_metadata_bbox_reflow(block))
        self.assertFalse(core.should_preserve_source_line_breaks(block, "body"))
        self.assertTrue(rendering.should_use_full_bbox_reflow(block))
        self.assertEqual(rendering.resolve_render_policy(block), "plain_reflow")

    def test_real_figure_caption_uses_reflow_instead_of_preserve_visual(self):
        block = deepcopy(next(item for item in self.cache_payload["blocks"] if item.get("id") == "p2_b2"))
        self.assertEqual(block.get("blockType"), "caption")
        self.assertEqual(rendering.resolve_caption_render_policy(block), "plain_reflow")
        self.assertEqual(rendering.resolve_render_policy(block), "plain_reflow")

    def test_preserve_visual_render_policy_skips_redaction_action(self):
        block = {
            "blockType": "caption",
            "renderPolicy": "preserve_visual",
            "translatedText": "图注",
            "bbox": [0, 0, 100, 20],
        }
        self.assertEqual(resolve_block_action(block), "preserve")

    def test_tiny_metadata_visual_label_is_preserved(self):
        block = deepcopy(self.p7_b12)
        self.assertTrue(core.is_tiny_metadata_visual_label(block))
        self.assertEqual(rendering.resolve_render_policy(block), "preserve_visual")
        self.assertEqual(resolve_block_action(block), "preserve")

    def test_strong_side_metadata_block_is_preserved(self):
        block = {
            "id": "side_meta",
            "page": 2,
            "pageWidth": 612.0,
            "pageHeight": 792.0,
            "blockType": "metadata",
            "bbox": [582.62, 16.0, 590.30, 783.76],
            "text": "2738, 2016, 1, Downloaded from https://onlinelibrary.wiley.com/doi/10.1155/2016/4248026, Wiley Online Library on [20/08/2026].",
        }
        self.assertTrue(preservation.is_side_marginalia_block(block))
        self.assertTrue(preservation.is_strong_side_metadata_block(block))

    def test_transformer_formula_pages_do_not_produce_false_positive_tables(self):
        self.assertIsNone(self._find_detected_page(self.transformer_table_detection, 5))

    def test_transformer_table_pages_detect_expected_tables(self):
        page6 = self._find_detected_page(self.transformer_table_detection, 6)
        self.assertIsNotNone(page6)
        self.assertEqual(len(page6.get("tables") or []), 1)
        self.assertEqual((page6.get("tables") or [])[0].get("bodyBlockIds"), ["p6_b1"])
        self.assertEqual((page6.get("tables") or [])[0].get("captionBlockIds"), ["p6_b0"])

        page9 = self._find_detected_page(self.transformer_table_detection, 9)
        self.assertIsNotNone(page9)
        self.assertEqual(len(page9.get("tables") or []), 1)
        self.assertEqual(
            set((page9.get("tables") or [])[0].get("bodyBlockIds") or []),
            {"p9_b1", "p9_b2", "p9_b3", "p9_b4", "p9_b5", "p9_b6", "p9_b7", "p9_b8", "p9_b9"},
        )

        page10 = self._find_detected_page(self.transformer_table_detection, 10)
        self.assertIsNotNone(page10)
        self.assertEqual(len(page10.get("tables") or []), 1)
        self.assertEqual((page10.get("tables") or [])[0].get("bodyBlockIds"), ["p10_b1"])
        self.assertEqual((page10.get("tables") or [])[0].get("captionBlockIds"), ["p10_b0"])

    def test_paper_table_detection_keeps_table_header_band_inside_body_bbox(self):
        page7 = self._find_detected_page(self.paper_table_detection, 7)
        self.assertIsNotNone(page7)
        self.assertEqual(len(page7.get("tables") or []), 1)
        table = (page7.get("tables") or [])[0]
        self.assertEqual(table.get("captionBlockIds"), ["p7_b43"])
        self.assertEqual(set(table.get("bodyBlockIds") or []), {"p7_b45", "p7_b46", "p7_b47"})
        bbox = table.get("bbox") or []
        self.assertEqual(len(bbox), 4)
        self.assertLessEqual(float(bbox[1]), 403.1)
        self.assertGreaterEqual(float(bbox[3]), 485.2)

    def test_single_body_table_fallback_detects_functional_brain_mapping_table(self):
        page12 = self._find_detected_page(self.fbmap_table_detection, 12)
        self.assertIsNotNone(page12)
        self.assertEqual(len(page12.get("tables") or []), 1)
        table = (page12.get("tables") or [])[0]
        self.assertEqual(table.get("captionBlockIds"), ["p12_b1"])
        self.assertEqual(table.get("headerBlockIds"), ["p12_b2"])
        self.assertEqual(table.get("bodyBlockIds"), ["p12_b3"])
        self.assertIn("p12_b0", table.get("footnoteBlockIds") or [])

    def test_single_body_table_fallback_rejects_caption_followed_by_prose(self):
        page_width = 600.0
        page_blocks = [
            {
                "id": "cap",
                "page": 1,
                "pageWidth": page_width,
                "blockType": "caption",
                "bbox": [60.0, 80.0, 240.0, 92.0],
                "text": "TABLE 1. Not actually a table",
                "layoutLines": [{"items": [{"text": "TABLE 1. Not actually a table", "type": "text"}]}],
                "fontSize": 8.0,
            },
            {
                "id": "hdr",
                "page": 1,
                "pageWidth": page_width,
                "blockType": "body",
                "bbox": [60.0, 100.0, 300.0, 112.0],
                "text": "Technique Basis Notes",
                "layoutLines": [{"items": [{"text": "Technique", "type": "text"}, {"text": "Basis", "type": "text"}, {"text": "Notes", "type": "text"}]}],
                "fontSize": 8.0,
            },
            {
                "id": "body",
                "page": 1,
                "pageWidth": page_width,
                "blockType": "table_body",
                "bbox": [60.0, 120.0, 520.0, 220.0],
                "text": "This paragraph continues in normal prose and should not be treated as a table body.",
                "layoutLines": [
                    {"items": [{"text": "This paragraph continues in normal prose", "type": "text", "bbox": [60.0, 122.0, 300.0, 130.0]}]},
                    {"items": [{"text": "and should not be treated as a table body.", "type": "text", "bbox": [60.0, 136.0, 320.0, 144.0]}]},
                    {"items": [{"text": "It is just wrapped body text.", "type": "text", "bbox": [60.0, 150.0, 230.0, 158.0]}]},
                ],
                "fontSize": 8.0,
            },
        ]
        tables = detect_tables._find_single_body_tables(page_blocks, page_width, set())
        self.assertEqual(tables, [])

    def test_single_body_table_fallback_rejects_heading_and_introductory_prose(self):
        page_width = 600.0
        page_blocks = [
            {
                "id": "cap",
                "page": 1,
                "pageWidth": page_width,
                "blockType": "caption",
                "bbox": [60.0, 80.0, 260.0, 92.0],
                "text": "TABLE 2. Background discussion",
                "layoutLines": [{"items": [{"text": "TABLE 2. Background discussion", "type": "text"}]}],
                "fontSize": 8.0,
            },
            {
                "id": "hdr",
                "page": 1,
                "pageWidth": page_width,
                "blockType": "heading",
                "bbox": [60.0, 100.0, 220.0, 114.0],
                "text": "Clinical Overview",
                "layoutLines": [{"items": [{"text": "Clinical Overview", "type": "text"}]}],
                "fontSize": 10.0,
                "role": "heading",
            },
            {
                "id": "body",
                "page": 1,
                "pageWidth": page_width,
                "blockType": "table_body",
                "bbox": [60.0, 122.0, 520.0, 210.0],
                "text": "The following section describes several clinical observations in narrative form, with dates and values embedded in sentences.",
                "layoutLines": [
                    {"items": [{"text": "The following section describes several clinical observations", "type": "text", "bbox": [60.0, 124.0, 360.0, 132.0]}]},
                    {"items": [{"text": "in narrative form, with dates and values embedded in sentences.", "type": "text", "bbox": [60.0, 138.0, 380.0, 146.0]}]},
                    {"items": [{"text": "No stable columns are present across lines.", "type": "text", "bbox": [60.0, 152.0, 280.0, 160.0]}]},
                ],
                "fontSize": 8.0,
            },
        ]
        tables = detect_tables._find_single_body_tables(page_blocks, page_width, set())
        self.assertEqual(tables, [])

    def test_single_body_table_fallback_accepts_caption_and_structured_body_without_header(self):
        page_width = 612.0
        page_blocks = [
            {
                "id": "cap",
                "page": 1,
                "pageWidth": page_width,
                "blockType": "caption",
                "bbox": [120.0, 100.0, 360.0, 112.0],
                "text": "Table 9: Hyperparameters.",
                "layoutLines": [{"items": [{"text": "Table 9: Hyperparameters.", "type": "text"}]}],
                "fontSize": 8.0,
            },
            {
                "id": "body",
                "page": 1,
                "pageWidth": page_width,
                "blockType": "body",
                "bbox": [120.0, 122.0, 440.0, 228.0],
                "text": "Optimizer AdamW stable Weight decay 0.01 low Sequence length 128 short Batch size 128 mid Steps 200000 long Warmup 10000 warm",
                "layoutLines": [
                    {"items": [{"text": "Optimizer", "type": "text", "bbox": [120.0, 122.0, 190.0, 132.0]}, {"text": "AdamW", "type": "text", "bbox": [280.0, 122.0, 330.0, 132.0]}, {"text": "stable", "type": "text", "bbox": [380.0, 122.0, 430.0, 132.0]}]},
                    {"items": [{"text": "weight decay", "type": "text", "bbox": [120.0, 138.0, 205.0, 148.0]}, {"text": "0.01", "type": "text", "bbox": [290.0, 138.0, 320.0, 148.0]}, {"text": "low", "type": "text", "bbox": [390.0, 138.0, 418.0, 148.0]}]},
                    {"items": [{"text": "Sequence length", "type": "text", "bbox": [120.0, 154.0, 220.0, 164.0]}, {"text": "128", "type": "text", "bbox": [290.0, 154.0, 315.0, 164.0]}, {"text": "short", "type": "text", "bbox": [380.0, 154.0, 425.0, 164.0]}]},
                    {"items": [{"text": "Batch size", "type": "text", "bbox": [120.0, 170.0, 185.0, 180.0]}, {"text": "128", "type": "text", "bbox": [290.0, 170.0, 315.0, 180.0]}, {"text": "mid", "type": "text", "bbox": [390.0, 170.0, 415.0, 180.0]}]},
                    {"items": [{"text": "Steps", "type": "text", "bbox": [120.0, 186.0, 160.0, 196.0]}, {"text": "200000", "type": "text", "bbox": [280.0, 186.0, 330.0, 196.0]}, {"text": "long", "type": "text", "bbox": [390.0, 186.0, 420.0, 196.0]}]},
                    {"items": [{"text": "Warmup", "type": "text", "bbox": [120.0, 202.0, 170.0, 212.0]}, {"text": "10000", "type": "text", "bbox": [280.0, 202.0, 325.0, 212.0]}, {"text": "warm", "type": "text", "bbox": [390.0, 202.0, 425.0, 212.0]}]},
                ],
                "fontSize": 8.0,
            },
        ]
        tables = detect_tables._find_single_body_tables(page_blocks, page_width, set())
        self.assertEqual(len(tables), 1)
        table = tables[0]
        self.assertEqual(table.get("captionBlockIds"), ["cap"])
        self.assertEqual(table.get("bodyBlockIds"), ["body"])
        self.assertEqual(table.get("headerBlockIds"), [])

    def test_figure_label_cluster_without_caption_is_rejected(self):
        cluster = [
            {
                "id": "p1_b0",
                "blockType": "table_body",
                "text": "LMψ text x Tokenizer (𝒱",
                "bbox": [146.0, 74.0, 346.0, 90.0],
                "layoutLines": [
                    {"items": [{"text": "LMψ", "type": "text", "bbox": [146.0, 74.0, 168.0, 82.0]}]},
                    {"items": [{"text": "text x", "type": "text", "bbox": [170.0, 74.0, 210.0, 82.0]}]},
                    {"items": [{"text": "Tokenizer", "type": "text", "bbox": [222.0, 74.0, 280.0, 82.0]}]},
                ],
            },
            {
                "id": "p1_b1",
                "blockType": "table_body",
                "text": "Hypernetwork",
                "bbox": [222.0, 106.0, 254.0, 120.0],
                "layoutLines": [
                    {"items": [{"text": "Hyper", "type": "text", "bbox": [222.0, 106.0, 240.0, 114.0]}]},
                    {"items": [{"text": "network", "type": "text", "bbox": [222.0, 114.0, 254.0, 120.0]}]},
                ],
            },
            {
                "id": "p1_b2",
                "blockType": "table_body",
                "text": "Input Embedding",
                "bbox": [251.0, 85.0, 289.0, 91.0],
                "layoutLines": [{"items": [{"text": "Input Embedding", "type": "text", "bbox": [251.0, 85.0, 289.0, 91.0]}]}],
            },
        ]
        self.assertTrue(detect_tables._looks_like_figure_label_cluster(cluster, [146.0, 74.0, 346.0, 120.0]))

    def test_headerish_multicolumn_token_row_is_not_rejected_as_sentence(self):
        block = {
            "id": "hdr",
            "page": 1,
            "pageWidth": 612.0,
            "fontSize": 8.0,
            "blockType": "metadata",
            "bbox": [164.0, 125.0, 504.0, 134.0],
            "text": "ar bg de el en es fr hi ru sw tr ur vi Avg.",
            "layoutLines": [
                {
                    "items": [
                        {"text": token, "type": "text", "bbox": [164.0 + idx * 20.0, 125.0, 174.0 + idx * 20.0, 134.0]}
                        for idx, token in enumerate(["ar", "bg", "de", "el", "en", "es", "fr", "hi", "ru", "sw", "tr", "ur", "vi", "Avg."])
                    ]
                }
            ],
        }
        self.assertTrue(detect_tables._looks_like_headerish_block(block, 612.0))

    def test_rule_group_splits_on_large_vertical_break(self):
        group = [
            [108.0, 122.007, 504.0, 122.007],
            [108.0, 137.325, 504.0, 137.325],
            [108.0, 152.493, 504.0, 152.493],
            [108.0, 207.511, 504.0, 207.511],
            [108.0, 232.792, 504.0, 232.792],
            [108.0, 295.458, 504.0, 295.458],
            [108.0, 346.666, 504.0, 346.666],
            [108.0, 372.793, 504.0, 372.793],
            [108.0, 398.920, 504.0, 398.920],
            [108.0, 425.197, 504.0, 425.197],
        ]
        parts = detect_tables._split_horizontal_rule_group(group)
        self.assertEqual(len(parts), 2)
        self.assertEqual(len(parts[0]), 5)
        self.assertEqual(len(parts[1]), 5)

    def test_rule_regions_do_not_merge_two_tables_across_large_gap(self):
        page_lines = [
            [108.0, 122.007, 504.0, 122.007],
            [108.0, 137.325, 504.0, 137.325],
            [108.0, 152.493, 504.0, 152.493],
            [108.0, 207.511, 504.0, 207.511],
            [108.0, 232.792, 504.0, 232.792],
            [108.0, 295.458, 504.0, 295.458],
            [108.0, 346.666, 504.0, 346.666],
            [108.0, 372.793, 504.0, 372.793],
            [108.0, 398.920, 504.0, 398.920],
            [108.0, 425.197, 504.0, 425.197],
        ]
        regions = detect_tables._build_rule_regions(page_lines, 612.0)
        self.assertEqual(len(regions), 2)
        self.assertLess(float(regions[0]["bbox"][3]), 240.0)
        self.assertGreater(float(regions[1]["bbox"][1]), 290.0)

    def test_rule_region_splits_when_internal_caption_separates_two_tables(self):
        region = {
            "bbox": [108.0, 132.916, 504.0, 349.114],
            "lines": [
                [108.0, 132.916, 504.0, 132.916],
                [108.0, 158.197, 504.0, 158.197],
                [108.0, 183.327, 504.0, 183.327],
                [108.0, 208.458, 504.0, 208.458],
                [108.0, 233.738, 504.0, 233.738],
                [108.0, 288.591, 504.0, 288.591],
                [108.0, 313.871, 504.0, 313.871],
                [108.0, 349.114, 504.0, 349.114],
            ],
            "maxGap": 54.853,
        }
        page_blocks = [
            {
                "id": "cap_mid",
                "blockType": "caption",
                "bbox": [107.691, 237.825, 504.343, 280.473],
                "text": "Table 13: Bits-per-character ...",
            }
        ]
        parts = detect_tables._split_rule_region_by_captions(region, page_blocks)
        self.assertEqual(len(parts), 2)
        self.assertEqual(len(parts[0]["lines"]), 5)
        self.assertEqual(len(parts[1]["lines"]), 3)
        self.assertLess(float(parts[0]["bbox"][3]), 240.0)
        self.assertGreater(float(parts[1]["bbox"][1]), 280.0)

    def test_refined_body_bbox_does_not_pull_into_caption_band(self):
        raw_body_bbox = [50.58, 321.249, 548.721, 446.979]
        page_lines = [
            [50.58, 290.262, 548.721, 290.262],
            [50.58, 321.249, 548.721, 321.249],
            [50.58, 346.557, 548.721, 346.557],
            [50.58, 396.768, 548.721, 396.768],
            [50.58, 446.979, 548.721, 446.979],
        ]
        refined = detect_tables._refine_bbox_with_horizontal_rules(raw_body_bbox, page_lines)
        refined[1] = max(float(refined[1]), float(raw_body_bbox[1]))
        self.assertAlmostEqual(float(refined[1]), 321.249, places=3)

    def test_mark_table_blocks_preserves_table_body_but_not_caption(self):
        payload = {
            "blocks": [
                {"id": "cap", "page": 1, "blockType": "caption", "text": "Table 1: Demo", "role": "paragraph"},
                {"id": "head", "page": 1, "blockType": "metadata", "text": "ColA ColB", "role": "paragraph"},
                {"id": "body", "page": 1, "blockType": "body", "text": "1 2", "role": "paragraph"},
            ]
        }
        detection = {
            "pages": [
                {
                    "page": 1,
                    "structures": [
                        {
                            "id": "p1_t1",
                            "kind": "table",
                            "bodyBlockIds": ["body"],
                            "headerBlockIds": ["head"],
                            "captionBlockIds": ["cap"],
                            "footnoteBlockIds": [],
                        }
                    ],
                }
            ]
        }

        detect_tables.mark_table_blocks(payload, detection)

        blocks = {block["id"]: block for block in payload["blocks"]}
        self.assertEqual(blocks["body"].get("blockType"), "table_body")
        self.assertIs(blocks["body"].get("preserveOriginal"), True)
        self.assertEqual(blocks["head"].get("blockType"), "table_header")
        self.assertIs(blocks["head"].get("preserveOriginal"), True)
        self.assertEqual(blocks["cap"].get("blockType"), "caption")
        self.assertIsNone(blocks["cap"].get("preserveOriginal"))
        self.assertEqual(blocks["cap"].get("tableRole"), "caption")

    def test_algorithm_structure_detection_finds_caption_and_body(self):
        page_blocks = [
            {
                "id": "alg_cap",
                "page": 1,
                "pageWidth": 612.0,
                "blockType": "metadata",
                "bbox": [108.0, 74.0, 408.0, 84.0],
                "text": "Algorithm 1 Hypernetwork training loop for Zero-Shot Tokenizer Transfer",
                "layoutLines": [{"items": [{"text": "Algorithm 1", "type": "text"}, {"text": " Hypernetwork training loop for Zero-Shot Tokenizer Transfer", "type": "text"}]}],
            },
            {
                "id": "alg_body1",
                "page": 1,
                "pageWidth": 612.0,
                "blockType": "body",
                "bbox": [108.0, 87.0, 504.0, 234.0],
                "text": "Input: corpus D Output: Hypernetwork parameters θ. 1: procedure TRAINHYPERNETWORK 2: θ ← θinit 3: q ← queue(x1, .., xn ∼ D)",
                "layoutLines": [
                    {"items": [{"text": "Input:", "type": "text", "bbox": [108.0, 87.0, 140.0, 97.0]}, {"text": "corpus D", "type": "text", "bbox": [160.0, 87.0, 215.0, 97.0]}]},
                    {"items": [{"text": "Output:", "type": "text", "bbox": [108.0, 101.0, 148.0, 111.0]}, {"text": "Hypernetwork parameters θ.", "type": "text", "bbox": [160.0, 101.0, 320.0, 111.0]}]},
                    {"items": [{"text": "1:", "type": "text", "bbox": [108.0, 115.0, 120.0, 125.0]}, {"text": "procedure TRAINHYPERNETWORK", "type": "text", "bbox": [160.0, 115.0, 360.0, 125.0]}]},
                    {"items": [{"text": "2:", "type": "text", "bbox": [108.0, 129.0, 120.0, 139.0]}, {"text": "θ ← θinit", "type": "text", "bbox": [160.0, 129.0, 220.0, 139.0]}]},
                    {"items": [{"text": "3:", "type": "text", "bbox": [108.0, 143.0, 120.0, 153.0]}, {"text": "q ← queue(x1, .., xn ∼ D)", "type": "text", "bbox": [160.0, 143.0, 330.0, 153.0]}]},
                    {"items": [{"text": "4:", "type": "text", "bbox": [108.0, 157.0, 120.0, 167.0]}, {"text": "for step in train_steps do", "type": "text", "bbox": [160.0, 157.0, 310.0, 167.0]}]},
                ],
                "fontSize": 8.0,
            },
            {
                "id": "alg_body2",
                "page": 1,
                "pageWidth": 612.0,
                "blockType": "body",
                "bbox": [108.0, 218.0, 472.0, 321.0],
                "text": "12: z ∼ Lognormal 13: for t, f do 14: p(t) ← f + N(0, z²) 15: Sort by p(t) descending 16: update θ using loss",
                "layoutLines": [
                    {"items": [{"text": "12:", "type": "text", "bbox": [108.0, 218.0, 125.0, 228.0]}, {"text": "z ∼ Lognormal", "type": "text", "bbox": [160.0, 218.0, 240.0, 228.0]}]},
                    {"items": [{"text": "13:", "type": "text", "bbox": [108.0, 232.0, 125.0, 242.0]}, {"text": "for t, f do", "type": "text", "bbox": [160.0, 232.0, 230.0, 242.0]}]},
                    {"items": [{"text": "14:", "type": "text", "bbox": [108.0, 246.0, 125.0, 256.0]}, {"text": "p(t) ← f + N(0, z²)", "type": "text", "bbox": [160.0, 246.0, 280.0, 256.0]}]},
                    {"items": [{"text": "15:", "type": "text", "bbox": [108.0, 260.0, 125.0, 270.0]}, {"text": "Sort by p(t) descending", "type": "text", "bbox": [160.0, 260.0, 300.0, 270.0]}]},
                    {"items": [{"text": "16:", "type": "text", "bbox": [108.0, 274.0, 125.0, 284.0]}, {"text": "update θ using loss", "type": "text", "bbox": [160.0, 274.0, 270.0, 284.0]}]},
                    {"items": [{"text": "17:", "type": "text", "bbox": [108.0, 288.0, 125.0, 298.0]}, {"text": "return θ", "type": "text", "bbox": [160.0, 288.0, 210.0, 298.0]}]},
                ],
                "fontSize": 8.0,
            },
            {
                "id": "after",
                "page": 1,
                "pageWidth": 612.0,
                "blockType": "body",
                "bbox": [108.0, 348.0, 504.0, 369.0],
                "text": "This is ordinary prose after the algorithm block.",
                "layoutLines": [{"items": [{"text": "This is ordinary prose after the algorithm block.", "type": "text", "bbox": [108.0, 348.0, 420.0, 358.0]}]}],
                "fontSize": 8.0,
            },
        ]
        structures = detect_tables._find_algorithm_structures(1, page_blocks, 612.0, set())
        self.assertEqual(len(structures), 1)
        structure = structures[0]
        self.assertEqual(structure.get("kind"), "algorithm")
        self.assertEqual(structure.get("captionBlockIds"), ["alg_cap"])
        self.assertEqual(structure.get("bodyBlockIds"), ["alg_body1", "alg_body2"])

    def test_ruled_table_bbox_keeps_left_label_column(self):
        page18 = self._find_detected_page(self.nihms_table_detection, 18)
        self.assertIsNotNone(page18)
        self.assertEqual(len(page18.get("tables") or []), 1)
        table = (page18.get("tables") or [])[0]
        bbox = table.get("bbox") or []
        self.assertEqual(len(bbox), 4)
        self.assertLessEqual(float(bbox[0]), 83.6)
        self.assertGreaterEqual(float(bbox[2]), 469.7)

    def test_rotated_table_page15_detected_as_single_coarse_region(self):
        page15 = self._find_detected_page(self.nihms_table_detection, 15)
        self.assertIsNotNone(page15)
        self.assertEqual(len(page15.get("tables") or []), 1)
        table = (page15.get("tables") or [])[0]
        bbox = table.get("bbox") or []
        display_bbox = table.get("displayBBox") or []
        self.assertEqual(len(bbox), 4)
        self.assertEqual(len(display_bbox), 4)
        self.assertGreaterEqual(float(bbox[0]), 90.0)
        self.assertLessEqual(float(bbox[1]), 70.0)
        self.assertGreaterEqual(float(bbox[2]), 450.0)
        self.assertGreaterEqual(float(bbox[3]), 880.0)
        self.assertLessEqual(float(display_bbox[0]), 60.0)
        self.assertGreaterEqual(float(display_bbox[3]), 890.0)

    def test_rotated_table_page16_detected_as_single_coarse_region(self):
        page16 = self._find_detected_page(self.nihms_table_detection, 16)
        self.assertIsNotNone(page16)
        self.assertEqual(len(page16.get("tables") or []), 1)
        bbox = ((page16.get("tables") or [])[0]).get("bbox") or []
        self.assertEqual(len(bbox), 4)
        self.assertLessEqual(float(bbox[0]), 60.0)
        self.assertLessEqual(float(bbox[1]), 70.0)
        self.assertGreaterEqual(float(bbox[2]), 338.0)
        self.assertGreaterEqual(float(bbox[3]), 890.0)

    def test_region_rotation_transform_round_trip(self):
        region = [40.0, 80.0, 240.0, 380.0]
        source_bbox = [92.0, 118.0, 156.0, 344.0]
        for rotation in (90, 270):
            transform = detect_tables._build_region_rotation_transform(region, rotation)
            normalized = detect_tables._transform_bbox(source_bbox, transform["matrix"])
            mapped_back = detect_tables._transform_bbox(normalized, transform["inverseMatrix"])
            for actual, expected in zip(mapped_back, source_bbox):
                self.assertAlmostEqual(actual, expected, places=4)

    def test_select_rotated_table_region_prefers_table_band(self):
        page_blocks = [
            {
                "id": "noise_left",
                "page": 1,
                "pageWidth": 600.0,
                "pageHeight": 800.0,
                "blockType": "heading",
                "bbox": [20.0, 80.0, 34.0, 720.0],
                "text": "Author Manuscript",
                "fontSize": 9.0,
            },
            {
                "id": "page_header",
                "page": 1,
                "pageWidth": 600.0,
                "pageHeight": 800.0,
                "blockType": "heading",
                "bbox": [90.0, 30.0, 520.0, 45.0],
                "text": "Meola et al. Page 15",
                "fontSize": 8.0,
            },
            {
                "id": "caption",
                "page": 1,
                "pageWidth": 600.0,
                "pageHeight": 800.0,
                "blockType": "heading",
                "bbox": [60.0, 420.0, 72.0, 470.0],
                "text": "Table 1.",
                "fontSize": 8.0,
            },
            {
                "id": "title",
                "page": 1,
                "pageWidth": 600.0,
                "pageHeight": 800.0,
                "blockType": "heading",
                "bbox": [78.0, 620.0, 90.0, 780.0],
                "text": "Studies about Augmented Reality in Neurosurgery",
                "fontSize": 8.0,
            },
        ]
        for index, x0 in enumerate((100.0, 114.0, 128.0, 142.0, 156.0, 170.0, 184.0, 198.0), start=0):
            page_blocks.append(
                {
                    "id": f"col{index}",
                    "page": 1,
                    "pageWidth": 600.0,
                    "pageHeight": 800.0,
                    "blockType": "table_body" if index >= 2 else "metadata",
                    "bbox": [x0, 100.0, x0 + 12.0, 700.0],
                    "text": f"col{index}",
                    "fontSize": 7.0,
                }
            )
        region = detect_tables._select_rotated_table_region(page_blocks, 600.0, 800.0)
        self.assertIsNotNone(region)
        self.assertLessEqual(float(region[0]), 90.0)
        self.assertLessEqual(float(region[1]), 95.0)
        self.assertGreaterEqual(float(region[2]), 210.0)
        self.assertGreaterEqual(float(region[3]), 705.0)
        self.assertGreater(float(region[0]), 10.0)

    def test_detect_table_on_normalized_region_maps_back_to_source_bbox(self):
        region = [0.0, 0.0, 600.0, 800.0]
        transform = detect_tables._build_region_rotation_transform(region, 90)
        normalized_blocks = [
            {
                "id": "cap",
                "page": 1,
                "pageWidth": 600.0,
                "pageHeight": 800.0,
                "blockType": "heading",
                "bbox": [84.0, 48.0, 96.0, 88.0],
                "text": "Table 1.",
                "layoutLines": [{"items": [{"text": "Table 1.", "type": "text"}]}],
                "fontSize": 8.0,
            },
            {
                "id": "hdr0",
                "page": 1,
                "pageWidth": 600.0,
                "pageHeight": 800.0,
                "blockType": "metadata",
                "bbox": [100.0, 100.0, 340.0, 114.0],
                "text": "Technique Basis Outcome",
                "layoutLines": [{"items": [
                    {"text": "Technique", "type": "text", "bbox": [100.0, 100.0, 150.0, 114.0]},
                    {"text": "Basis", "type": "text", "bbox": [190.0, 100.0, 230.0, 114.0]},
                    {"text": "Outcome", "type": "text", "bbox": [270.0, 100.0, 330.0, 114.0]},
                ]}],
                "fontSize": 7.0,
            },
        ]
        body_lines = []
        for row_index, y0 in enumerate((124.0, 138.0, 152.0, 166.0, 180.0, 194.0), start=1):
            body_lines.append(
                {
                    "items": [
                        {"text": f"R{row_index}", "type": "text", "bbox": [100.0, y0, 135.0, y0 + 10.0]},
                        {"text": f"{row_index * 10}", "type": "text", "bbox": [190.0, y0, 220.0, y0 + 10.0]},
                        {"text": f"V{row_index}", "type": "text", "bbox": [270.0, y0, 315.0, y0 + 10.0]},
                    ]
                }
            )
        normalized_blocks.append(
            {
                "id": "body",
                "page": 1,
                "pageWidth": 600.0,
                "pageHeight": 800.0,
                "blockType": "table_body",
                "bbox": [100.0, 120.0, 340.0, 208.0],
                "text": "R1 10 V1 R2 20 V2 R3 30 V3 R4 40 V4 R5 50 V5 R6 60 V6",
                "layoutLines": body_lines,
                "fontSize": 7.0,
            }
        )

        source_blocks = []
        for block in normalized_blocks:
            source = deepcopy(block)
            source["bbox"] = detect_tables._transform_bbox(block["bbox"], transform["inverseMatrix"])
            for line in source.get("layoutLines") or []:
                for item in line.get("items") or []:
                    if "bbox" in item:
                        item["bbox"] = detect_tables._transform_bbox(item["bbox"], transform["inverseMatrix"])
            source_blocks.append(source)

        rotated_blocks, rotated_transform = detect_tables._normalize_rotated_blocks(source_blocks, region, rotation=90)
        normalized_result = detect_tables._detect_table_on_normalized_region(1, rotated_blocks, [], merge_gap=120.0)
        self.assertIsNotNone(normalized_result)
        self.assertEqual(len(normalized_result.get("tables") or []), 1)
        mapped = detect_tables._map_detected_table_back((normalized_result.get("tables") or [])[0], rotated_transform)
        bbox = mapped.get("bbox") or []
        display_bbox = mapped.get("displayBBox") or []
        self.assertEqual(len(bbox), 4)
        self.assertEqual(len(display_bbox), 4)
        expected_bbox = detect_tables._union_bboxes([source_blocks[1]["bbox"], source_blocks[2]["bbox"]])
        self.assertIsNotNone(expected_bbox)
        for actual, expected in zip(bbox, expected_bbox or []):
            self.assertAlmostEqual(float(actual), float(expected), places=1)
        self.assertLessEqual(float(display_bbox[0]), float(bbox[0]))
        self.assertLessEqual(float(display_bbox[1]), float(bbox[1]))
        self.assertGreaterEqual(float(display_bbox[2]), float(bbox[2]))
        self.assertGreaterEqual(float(display_bbox[3]), float(bbox[3]))


if __name__ == "__main__":
    unittest.main()
