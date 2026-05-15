from __future__ import annotations

import json
import os
import statistics
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from domain import common, layout, preservation


def extract_blocks(
    input_pdf: str,
    output_json: str,
    pages: Optional[List[int]] = None,
) -> None:
    fitz = common.require_fitz()
    doc = fitz.open(input_pdf)
    pages_blocks: List[List[Dict[str, Any]]] = []
    page_heights = {
        page_index + 1: float(doc[page_index].rect.height)
        for page_index in range(len(doc))
    }
    docling_items, docling_summary = layout.extract_docling_layout_items(
        input_pdf,
        page_heights,
        pages=pages,
    )
    docling_items_by_page: Dict[int, List[Dict[str, Any]]] = {}
    for item in docling_items:
        docling_items_by_page.setdefault(int(item["page"]), []).append(item)
    matched_docling_blocks = 0
    docling_label_counts: Dict[str, int] = {}

    page_indexes = range(len(doc)) if not pages else [page - 1 for page in pages if page <= len(doc)]
    for page_index in page_indexes:
        page = doc[page_index]
        page_dict = page.get_text("dict")
        page_width = float(page.rect.width)
        page_height = float(page.rect.height)
        page_blocks: List[Dict[str, Any]] = []
        for block_index, block in enumerate(page_dict.get("blocks", [])):
            if block.get("type") != 0:
                continue

            lines = []
            layout_lines = []
            max_font_size = 0.0
            span_sizes = []
            rotations = []
            block_flag_values: Set[int] = set()
            block_has_italic = False
            block_has_monospace = False
            block_has_bold = False
            block_has_superscript = False
            block_has_subscript = False
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                line_text = common.normalize_text("".join(span.get("text", "") for span in spans))
                if line_text:
                    lines.append(line_text)
                    rotations.append(common.direction_to_rotation(line.get("dir")))
                line_items = []
                for span in spans:
                    size = float(span.get("size", 0) or 0)
                    max_font_size = max(max_font_size, size)
                    if size > 0:
                        span_sizes.append(size)
                block_font_size = common.dominant_font_size(span_sizes) if span_sizes else 10.0
                for span in spans:
                    span_text = str(span.get("text", "") or "")
                    if not span_text:
                        continue
                    size = float(span.get("size", 0) or 0)
                    span_bbox = [float(v) for v in span.get("bbox", [0, 0, 0, 0])]
                    line_bbox = [float(v) for v in line.get("bbox", [0, 0, 0, 0])]
                    span_flags = int(span.get("flags", 0) or 0)
                    span_flag_hints = common.decode_span_flags(span_flags)
                    geom_offset_hints = common.detect_geometric_script_offset(
                        span_bbox,
                        line_bbox,
                        size,
                        block_font_size,
                    )
                    block_flag_values.add(span_flags)
                    block_has_italic = block_has_italic or span_flag_hints["isItalicLike"]
                    block_has_monospace = block_has_monospace or span_flag_hints["isMonospaceLike"]
                    block_has_bold = block_has_bold or span_flag_hints["isBoldLike"]
                    block_has_superscript = (
                        block_has_superscript
                        or span_flag_hints["isSuperscriptLike"]
                        or geom_offset_hints["geomSuperscriptLike"]
                    )
                    block_has_subscript = (
                        block_has_subscript
                        or geom_offset_hints["geomSubscriptLike"]
                    )
                    line_items.append(
                        {
                            "type": "formula" if common.is_formula_span(span, block_font_size) else "text",
                            "text": span_text,
                            "bbox": span_bbox,
                            "font": str(span.get("font", "") or ""),
                            "size": float(span.get("size", 0) or 0),
                            "color": common.pdf_int_color_to_rgb(span.get("color")),
                            "flags": span_flags,
                            **span_flag_hints,
                            **geom_offset_hints,
                            "isSuperscriptLike": bool(
                                span_flag_hints["isSuperscriptLike"]
                                or geom_offset_hints["geomSuperscriptLike"]
                            ),
                            "isSubscriptLike": bool(geom_offset_hints["geomSubscriptLike"]),
                        }
                    )
                merged_items = common.merge_span_items(line_items)
                if merged_items:
                    layout_lines.append(
                        {
                            "bbox": [float(v) for v in line.get("bbox", [0, 0, 0, 0])],
                            "items": merged_items,
                        }
                    )

            text = common.normalize_text("\n".join(lines))
            if not text:
                continue

            x0, y0, x1, y1 = [float(v) for v in block.get("bbox", [0, 0, 0, 0])]
            page_blocks.append(
                {
                    "id": f"p{page_index + 1}_b{block_index}",
                    "page": page_index + 1,
                    "bbox": [x0, y0, x1, y1],
                    "pageWidth": page_width,
                    "pageHeight": page_height,
                    "fontSize": common.dominant_font_size(span_sizes),
                    "medianFontSize": common.representative_font_size(span_sizes),
                    "maxFontSize": max_font_size or 10,
                    "hasSizeJump": (
                        bool(span_sizes)
                        and max(span_sizes) - min(span_sizes) >= 1.5
                    ),
                    "rotation": max(set(rotations), key=rotations.count) if rotations else 0,
                    "layoutLines": layout_lines,
                    "role": "paragraph",
                    "spanFlags": sorted(block_flag_values),
                    "hasItalicLike": block_has_italic,
                    "hasMonospaceLike": block_has_monospace,
                    "hasBoldLike": block_has_bold,
                    "hasSuperscriptLike": block_has_superscript,
                    "hasSubscriptLike": block_has_subscript,
                    "text": text,
                }
            )

        body_font_candidates = [
            float(block["fontSize"])
            for block in page_blocks
            if 6 <= float(block["fontSize"]) <= 14 and len(common.normalize_text(block["text"])) >= 20
        ]
        page_body_font_size = (
            float(statistics.median(body_font_candidates))
            if body_font_candidates
            else 10.0
        )

        for block in page_blocks:
            matched_docling_item = layout.match_docling_item_to_block(
                block,
                docling_items_by_page.get(page_index + 1, []),
            )
            if matched_docling_item:
                block["doclingLabel"] = matched_docling_item.get("label")
                block["doclingText"] = matched_docling_item.get("text")
                matched_docling_blocks += 1
                label = str(matched_docling_item.get("label") or "unknown")
                docling_label_counts[label] = docling_label_counts.get(label, 0) + 1

        for block in page_blocks:
            if block.get("doclingLabel") in ("title", "section_header"):
                if layout.is_paragraph_like_heading_candidate(block, page_body_font_size):
                    block["role"] = "paragraph"
                    block["_demotedFromHeading"] = True
                    block["_proseHeadingSequence"] = True
                else:
                    block["role"] = "heading"
                    block["fontSize"] = max(float(block["fontSize"]), page_body_font_size + 1.0)
            elif layout.looks_like_heading(block["text"], float(block["fontSize"]), page_body_font_size):
                if not layout.is_paragraph_like_heading_candidate(block, page_body_font_size):
                    block["role"] = "heading"
                    block["fontSize"] = max(float(block["fontSize"]), page_body_font_size + 1.0)

        ordered_page_blocks = sorted(
            page_blocks,
            key=lambda block: (
                float((block.get("bbox") or [0, 0, 0, 0])[1]),
                float((block.get("bbox") or [0, 0, 0, 0])[0]),
            ),
        )
        active_prose_heading = None
        for block in ordered_page_blocks:
            if layout.is_heading_prose_continuation(active_prose_heading, block):
                block["role"] = "paragraph"
                block["_demotedFromHeading"] = True
                block["_proseHeadingSequence"] = True
                active_prose_heading = block
                continue
            if str(block.get("doclingLabel") or "") in {"section_header", "title"} and (
                layout.looks_like_prose_block(block) or bool(block.get("_demotedFromHeading"))
            ):
                block["_proseHeadingSequence"] = True
                active_prose_heading = block
                continue
            active_prose_heading = None

        page_body_width = layout.estimate_page_body_width(page_blocks, page_body_font_size)
        for block in page_blocks:
            if layout.should_demote_heading_block(block, page_body_font_size, page_body_width):
                block["role"] = "paragraph"
                block["blockType"] = "body"
                block["layoutIntent"] = "generic"
                block["_demotedFromHeading"] = True
                block["_proseHeadingSequence"] = True

        for block in page_blocks:
            if block.get("_demotedFromHeading"):
                block["role"] = "paragraph"
                block["blockType"] = "body"
                block["layoutIntent"] = "generic"
            wrap_shape_profile = layout.build_wrap_shape_profile(block)
            block["wrapShape"] = str(wrap_shape_profile.get("wrapShape") or "regular")
            block["wrapLineTemplates"] = list(wrap_shape_profile.get("wrapLineTemplates") or [])
            block["pageBodyFontSize"] = page_body_font_size
            block["pageBodyWidth"] = page_body_width
            block["isBodyLike"] = layout.is_body_like_block(
                block,
                page_body_width,
                page_body_font_size,
            )
            if block.get("_demotedFromHeading"):
                block["isBodyLike"] = True
            block["blockType"] = layout.resolve_block_type(
                block,
                page_body_width,
                page_body_font_size,
            )
            block["layoutIntent"] = layout.resolve_layout_intent(
                block,
                page_body_width,
                page_body_font_size,
            )

        layout.mark_drop_cap_relations(page_blocks, page_body_font_size)

        for block in page_blocks:
            block["preferredTextStyle"] = layout.get_preferred_text_style(
                block,
                layout.get_font_role(block),
                bool(block.get("role") == "heading"),
            )
            block["styleFamilyClass"] = layout.block_style_family_class(
                block,
                layout.get_font_role(block),
            )
            block["defaultStyle"] = layout.build_block_default_style(block)

        page_body_latin_family = layout.dominant_page_body_latin_family(page_blocks)
        for block in page_blocks:
            block["pageBodyLatinFamily"] = page_body_latin_family

        preserved_regions = preservation.detect_scored_table_regions(page, page_blocks, page_width)
        preserved_figure_ids = preservation.detect_preserved_figure_block_ids(
            page_blocks,
            page_width,
            page_height,
        )
        for block in page_blocks:
            if str(block.get("doclingLabel") or "") in ("picture", "chart"):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "picture_region"
                block["blockType"] = "other"
            elif block["id"] in preserved_figure_ids:
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "figure_label"
                block["blockType"] = "other"
            elif any(
                common.bbox_overlap_ratio(block["bbox"], region) >= 0.6
                and preservation.is_table_body_block(block)
                for region in preserved_regions
            ):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "table_region"
                block["blockType"] = "table_body"
            elif common.has_private_use_garbage(block["text"]):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "garbled_text"
                block["blockType"] = "other"
            elif common.is_display_formula_block(block):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "display_formula"
                block["blockType"] = "formula_display"
            elif common.is_formula_heavy_text(block["text"]):
                if block.get("blockType") != "body":
                    block["preserveOriginal"] = True
                    block["role"] = "preserved"
                    block["preserveReason"] = "formula_heavy"
                    block["blockType"] = "formula_display"
        pages_blocks.append(page_blocks)

    layout.mark_reference_sections(pages_blocks)

    preserved_peripheral_ids = preservation.detect_preserved_peripheral_block_ids(pages_blocks)
    blocks: List[Dict[str, Any]] = []
    for page_blocks in pages_blocks:
        for block in page_blocks:
            if block.get("blockType") == "reference_block":
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "reference_block"
            if block["id"] in preserved_peripheral_ids:
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block.setdefault("preserveReason", "peripheral_repeat")
            blocks.append(block)

    payload = {
        "version": common.PDF_BLOCKS_SCHEMA_VERSION,
        "sourceFile": os.path.basename(input_pdf),
        "title": Path(input_pdf).stem,
        "doclingSummary": {
            **docling_summary,
            "matchedBlocks": matched_docling_blocks,
            "labelCounts": docling_label_counts,
        },
        "blocks": blocks,
    }
    Path(output_json).parent.mkdir(parents=True, exist_ok=True)
    Path(output_json).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if docling_summary.get("enabled"):
        sorted_labels = sorted(
            docling_label_counts.items(),
            key=lambda item: (-item[1], item[0]),
        )
        label_preview = ", ".join(f"{label}={count}" for label, count in sorted_labels[:6]) or "none"
        print(
            "Docling: "
            f"status={docling_summary.get('status')} "
            f"items={docling_summary.get('items', 0)} "
            f"matchedBlocks={matched_docling_blocks} "
            f"batchPages={docling_summary.get('batchPages', 0)} "
            f"batches={docling_summary.get('batches', 0)} "
            f"elapsedMs={docling_summary.get('elapsedMs', 0)} "
            f"labels=[{label_preview}]"
        )
    else:
        print(
            "Docling: "
            f"status={docling_summary.get('status')} "
            f"error={docling_summary.get('error', 'unknown')}"
        )
    print(f"Extracted {len(blocks)} text block(s) to {output_json}")
