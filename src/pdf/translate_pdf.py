#!/usr/bin/env python3
"""PDF JSON extraction and translated text backfill for Wasabi.

This helper intentionally does not translate. Node/Wasabi owns translation;
Python only extracts structured JSON text blocks and writes translated text back
into a copy of the PDF.

Requires PyMuPDF:
    python3 -m pip install pymupdf
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from vector_extract import RebuildOptions, rebuild_pdf_graphic_layers


def require_fitz():
    try:
        import fitz  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "PyMuPDF is required for PDF support. Install it with: "
            "python3 -m pip install pymupdf"
        ) from exc
    return fitz


def normalize_text(value: str) -> str:
    return " ".join((value or "").split())


def sanitize_translated_text(value: str) -> str:
    normalized = normalize_text(value)
    normalized = re.sub(r"</?pad>", "", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"</?eos>", "", normalized, flags=re.IGNORECASE)
    normalized = normalized.replace("<pad>", "").replace("<EOS>", "")
    normalized = normalized.replace("&lt;pad&gt;", "").replace("&lt;EOS&gt;", "")
    return normalize_text(normalized)


SECTION_HEADING_REGEX = re.compile(
    r"^(?:\d+(?:\.\d+)*|[A-Z])(?:[.)])?\s+[^\s].{0,120}$"
)
FORMULA_SYMBOL_REGEX = re.compile(r"[=≈≤≥∑∫√^×÷∈∉∞∂∆∇∝⊂⊆⊕⊗→←↔±≠]")
FORMULA_TOKEN_REGEX = re.compile(
    r"(?:\b[A-Za-z]\w*\s*\(|\b(?:sin|cos|tan|log|ln|max|min|softmax)\b|[_^{}]|[₀-₉⁰-⁹])"
)
PRIVATE_USE_GARBAGE_REGEX = re.compile(r"[\uE000-\uF8FF\U000F0000-\U000FFFFD\U00100000-\U0010FFFD]")
MATH_FONT_REGEX = re.compile(r"^(?:CM|MSAM|MSBM|StandardSymL|Symbol|MTExtra)", re.IGNORECASE)
INLINE_FORMULA_PLACEHOLDER_REGEX = re.compile(r"@@WASABI_INLINE_FORMULA_\d+@@")
HANGING_PUNCTUATION = set("、，。；：！？）》】」』〕〉》」』）】%.,;:!?)]}")
LEADING_PUNCTUATION = set("（【《〈「『〔“‘([<{")
ARXIV_METADATA_REGEX = re.compile(
    r"^arxiv:\d{4}\.\d{4,5}(?:v\d+)?\s+\[[A-Za-z.\-]+\]\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}$",
    flags=re.IGNORECASE,
)
PDF_BLOCKS_SCHEMA_VERSION = 2


def decode_span_flags(flags: int) -> Dict[str, bool]:
    return {
        "isSuperscriptLike": bool(flags & 1),
        "isItalicLike": bool(flags & 2),
        "isSerifLike": bool(flags & 4),
        "isMonospaceLike": bool(flags & 8),
        "isBoldLike": bool(flags & 16),
    }


def contains_cjk(text: str) -> bool:
    return bool(re.search(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", text or ""))


def require_docling_converter():
    try:
        from docling.document_converter import DocumentConverter  # type: ignore
    except ImportError:
        return None
    return DocumentConverter


def is_caption_like(text: str) -> bool:
    normalized = normalize_text(text)
    return bool(
        re.match(r"^(?:figure|fig\.|table)\s+\d+[.:]?\s+", normalized, flags=re.IGNORECASE)
        or re.match(r"^(?:图|表)\s*\d+[：:.\s]", normalized)
    )


def is_arxiv_metadata_like(text: str) -> bool:
    normalized = normalize_text(text)
    return bool(ARXIV_METADATA_REGEX.match(normalized))


def is_code_like(text: str) -> bool:
    return False


def get_font_role(block: Dict[str, Any]) -> str:
    block_type = str(block.get("blockType") or "")
    if block_type == "code":
        return "code"
    if block_type == "caption":
        return "caption"
    if block_type == "heading":
        return "heading"
    text = normalize_text(block.get("text") or "")
    if is_code_like(text):
        return "code"
    if is_caption_like(text):
        return "caption"
    if block.get("role") == "heading":
        return "heading"
    return "body"


def get_preferred_text_style(
    block: Dict[str, Any],
    font_role: str,
    bold: bool = False,
) -> str:
    if font_role == "code":
        return "monospace"
    if block.get("hasItalicLike") and not contains_cjk(normalize_text(block.get("text") or "")):
        return "bold_italic" if (font_role == "heading" or bold or block.get("hasBoldLike")) else "italic"
    if font_role == "heading" or bold or block.get("hasBoldLike"):
        return "bold"
    return "normal"


def get_source_line_style(
    block: Dict[str, Any],
    line_index: int,
    default_font_role: str,
    default_bold: bool,
) -> Dict[str, Any]:
    layout_lines = block.get("layoutLines") or []
    if line_index < 0 or line_index >= len(layout_lines):
        return {
            "font_role": default_font_role,
            "bold": default_bold,
            "preferred_style": get_preferred_text_style(block, default_font_role, default_bold),
        }

    items = layout_lines[line_index].get("items", []) or []
    text_items = [item for item in items if item.get("type") == "text" and normalize_text(str(item.get("text", "") or ""))]
    if not text_items:
        return {
            "font_role": default_font_role,
            "bold": default_bold,
            "preferred_style": get_preferred_text_style(block, default_font_role, default_bold),
        }

    monospace_only = all(bool(item.get("isMonospaceLike")) for item in text_items)
    has_bold = any(bool(item.get("isBoldLike")) for item in text_items)
    has_italic = any(bool(item.get("isItalicLike")) for item in text_items)
    has_superscript = any(bool(item.get("isSuperscriptLike")) for item in text_items)
    line_text = normalize_text("".join(str(item.get("text", "") or "") for item in text_items))
    line_is_cjk = contains_cjk(line_text)

    if monospace_only:
        return {"font_role": "code", "bold": False, "preferred_style": "monospace"}
    if has_italic and not line_is_cjk:
        preferred_style = "bold_italic" if has_bold else "italic"
        return {"font_role": default_font_role, "bold": bool(has_bold or default_bold), "preferred_style": preferred_style}
    if has_bold:
        return {"font_role": default_font_role, "bold": True, "preferred_style": "bold"}
    if has_superscript and default_font_role == "metadata":
        return {
            "font_role": default_font_role,
            "bold": default_bold,
            "preferred_style": get_preferred_text_style(block, default_font_role, default_bold),
        }
    return {
        "font_role": default_font_role,
        "bold": default_bold,
        "preferred_style": get_preferred_text_style(block, default_font_role, default_bold),
    }


def is_formula_like_text(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    symbol_count = len(FORMULA_SYMBOL_REGEX.findall(normalized))
    token_hits = len(FORMULA_TOKEN_REGEX.findall(normalized))
    latin_count = len(re.findall(r"[A-Za-z]", normalized))
    digit_count = len(re.findall(r"\d", normalized))
    word_count = len(re.findall(r"[A-Za-z]{3,}", normalized))

    if FORMULA_SYMBOL_REGEX.search(normalized) and token_hits >= 1:
        return True
    if token_hits >= 2 and latin_count + digit_count >= 4 and word_count <= 6:
        return True
    if normalized.count("(") + normalized.count(")") >= 2 and symbol_count >= 1:
        return True
    return False


def is_formula_span(span: Dict[str, Any], block_font_size: float = 10.0) -> bool:
    text = str(span.get("text", "") or "")
    normalized = normalize_text(text)
    if not normalized:
        return False

    font_name = str(span.get("font", "") or "")
    size = float(span.get("size", 0) or 0)
    flags = int(span.get("flags", 0) or 0)

    if MATH_FONT_REGEX.search(font_name):
        return True
    if FORMULA_SYMBOL_REGEX.search(normalized):
        return True
    if FORMULA_TOKEN_REGEX.search(normalized) and len(re.findall(r"[A-Za-z0-9]", normalized)) <= 12:
        return True
    if len(normalized) <= 4 and re.fullmatch(r"[A-Za-z0-9_]+", normalized) and size and size < max(block_font_size * 0.82, block_font_size - 1.2):
        return True
    if flags & 2 and len(normalized) <= 4 and re.fullmatch(r"[A-Za-z0-9_]+", normalized):
        return True
    return False


def merge_span_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    for item in items:
        text = str(item.get("text", "") or "")
        if not text:
            continue
        bbox = [float(v) for v in item.get("bbox", [0, 0, 0, 0])]
        item_type = item.get("type") or "text"
        style_signature = (
            int(item.get("flags", 0) or 0),
            str(item.get("font", "") or ""),
            round(float(item.get("size", 0) or 0), 2),
        )
        if (
            merged
            and merged[-1]["type"] == item_type
            and merged[-1].get("_styleSignature") == style_signature
        ):
            merged[-1]["text"] += text
            merged[-1]["bbox"] = expand_bbox(merged[-1]["bbox"], bbox)
            continue
        merged.append({**item, "type": item_type, "text": text, "bbox": bbox, "_styleSignature": style_signature})

    for item in merged:
        item.pop("_styleSignature", None)
    return merged


def has_private_use_garbage(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    return bool(PRIVATE_USE_GARBAGE_REGEX.search(normalized))


def is_formula_heavy_text(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False

    symbol_count = len(FORMULA_SYMBOL_REGEX.findall(normalized))
    token_hits = len(FORMULA_TOKEN_REGEX.findall(normalized))
    latin_count = len(re.findall(r"[A-Za-z]", normalized))
    digit_count = len(re.findall(r"\d", normalized))
    sub_super_count = len(re.findall(r"[_^₀-₉⁰-⁹]", normalized))

    if has_private_use_garbage(normalized):
        return True
    if symbol_count >= 2 and token_hits >= 2:
        return True
    if token_hits >= 4 and latin_count + digit_count >= 8:
        return True
    if sub_super_count >= 3 and latin_count >= 4:
        return True
    return False


def is_display_formula_block(block: Dict[str, Any]) -> bool:
    text = normalize_text(block.get("text") or "")
    if not text or len(text) > 180:
        return False

    x0, y0, x1, y1 = block["bbox"]
    page_width = max(float(block["pageWidth"] or 1), 1.0)
    width = max(x1 - x0, 1.0)
    center_x = (x0 + x1) / 2.0
    page_center_x = page_width / 2.0
    centered = abs(center_x - page_center_x) <= page_width * 0.12
    width_ratio = width / page_width

    symbol_count = len(FORMULA_SYMBOL_REGEX.findall(text))
    token_hits = len(FORMULA_TOKEN_REGEX.findall(text))
    latin_count = len(re.findall(r"[A-Za-z]", text))
    prose_chunk_count = len(
        re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]{4,}|[A-Z][a-z]{3,}|[a-z]{4,}", text)
    )
    sentence_punct_count = len(re.findall(r"[，。；：.!?]", text))

    if not centered:
        return False
    if width_ratio < 0.18 or width_ratio > 0.72:
        return False
    if prose_chunk_count >= 2 and sentence_punct_count >= 1:
        return False
    if symbol_count >= 1 and token_hits >= 2 and latin_count >= 4:
        return True
    if token_hits >= 3 and latin_count >= 6:
        return True
    return False


def estimate_text_units(text: str) -> float:
    units = 0.0
    for char in text:
        if char.isspace():
            units += 0.35
        elif re.match(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", char):
            units += 1.0
        elif re.match(r"[A-Z0-9]", char):
            units += 0.68
        elif re.match(r"[a-z]", char):
            units += 0.56
        else:
            units += 0.6
    return units


def wrap_text_for_box(text: str, rect, fontsize: float) -> str:
    normalized = normalize_text(text)
    if not normalized:
        return ""

    max_units = max((rect.width - 4) / max(fontsize * 0.62, 0.1), 2.0)
    lines: List[str] = []
    current = ""
    current_units = 0.0

    for token in re.findall(r"\S+\s*|\s+", normalized):
        token_units = estimate_text_units(token)
        if current and current_units + token_units > max_units:
            lines.append(current.rstrip())
            current = token.lstrip()
            current_units = estimate_text_units(current)
            continue
        current += token
        current_units += token_units

    if current.strip():
        lines.append(current.rstrip())

    return "\n".join(lines)


def tokenize_plain_text(text: str) -> List[str]:
    return [
        token
        for token in re.findall(
            r"(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*)|(?:https?://\S+\s*)|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[A-Za-z0-9_]+(?:['-][A-Za-z0-9_]+)*\s*|\s+|[^\s]",
            text,
        )
        if token
    ]


def is_hanging_punctuation_token(token: str) -> bool:
    normalized = (token or "").strip()
    return bool(normalized) and normalized in HANGING_PUNCTUATION


def is_leading_punctuation_token(token: str) -> bool:
    normalized = (token or "").strip()
    return bool(normalized) and normalized in LEADING_PUNCTUATION


def is_footnote_marker_token(token: str) -> bool:
    normalized = (token or "").strip()
    return normalized in {"*", "∗", "†", "‡", "§", "¶"}


def metadata_line_start_markers(block: Dict[str, Any]) -> List[str]:
    markers: List[str] = []
    for line in (block.get("layoutLines") or [])[1:]:
        items = line.get("items", []) or []
        if not items:
            continue
        first_item = items[0]
        first_text = normalize_text(str(first_item.get("text", "") or ""))
        if not is_footnote_marker_token(first_text):
            continue
        if len(items) >= 2 and normalize_text(str(items[1].get("text", "") or "")):
            markers.append(first_text)
    return markers


def split_metadata_marker_segments(text: str, block: Dict[str, Any]) -> List[str]:
    normalized = normalize_text(text)
    if not normalized:
        return []
    markers = metadata_line_start_markers(block)
    if not markers:
        return [normalized]
    marker_pattern = "|".join(re.escape(marker) for marker in sorted(set(markers), key=len, reverse=True))
    marked = re.sub(rf"\s*({marker_pattern})", r"\n\1", normalized).lstrip()
    return [segment.strip() for segment in marked.split("\n") if segment.strip()]


def wrap_compact_metadata_by_fields(text: str, block: Dict[str, Any]) -> Optional[str]:
    normalized = normalize_text(text)
    if not normalized:
        return ""

    layout_lines = block.get("layoutLines") or []
    source_lines = []
    for line in layout_lines:
        items = line.get("items", []) or []
        line_text = normalize_text("".join(str(item.get("text", "") or "") for item in items))
        if line_text:
            source_lines.append({"text": line_text, "items": items})

    if not source_lines or len(source_lines) > 4:
        return None

    # Footnote-like metadata should use the dedicated marker-segment path instead.
    if any(
        items and is_footnote_marker_token(normalize_text(str(items[0].get("text", "") or "")))
        and len(items) >= 2
        and normalize_text(str(items[1].get("text", "") or ""))
        for items in (line["items"] for line in source_lines[1:])
    ):
        return None

    line_widths = []
    for line in source_lines:
        bbox = line["items"][0].get("bbox") if len(line["items"]) == 1 else None
        if bbox and len(bbox) == 4:
            line_widths.append(max(float(bbox[2]) - float(bbox[0]), 0.0))
        else:
            text_units = estimate_text_units(line["text"])
            line_widths.append(text_units)

    token_counts = [len(re.findall(r"\S+", line["text"])) for line in source_lines]
    total_text_units = estimate_text_units(normalized)
    avg_line_units = total_text_units / max(len(source_lines), 1)

    # Field-like multiline metadata is short, line-oriented, and not prose-like.
    if len(source_lines) < 2 or len(source_lines) > 4:
        return None
    if any(len(line["text"]) >= 80 for line in source_lines):
        return None
    if len(re.findall(r"[，。；：.!?]", normalized)) >= 3:
        return None
    if any(count >= 6 for count in token_counts[:-1]):
        return None
    if avg_line_units >= 22:
        return None
    width_spread = max(line_widths) - min(line_widths) if line_widths else 0.0
    if width_spread <= 0 and len(source_lines) >= 3:
        return None
    if all(count <= 1 for count in token_counts):
        return None

    fields = re.findall(r"\S+", normalized)
    if len(fields) < len(source_lines):
        return None

    lines: List[str] = []
    field_index = 0
    for line_index in range(len(source_lines)):
        remaining_lines = len(source_lines) - line_index
        remaining_fields = len(fields) - field_index
        if remaining_fields <= 0:
            break
        take_count = 1 if remaining_fields >= remaining_lines else max(remaining_fields - remaining_lines + 1, 1)
        if line_index == len(source_lines) - 1:
            take_count = remaining_fields
        line_fields = fields[field_index : field_index + take_count]
        lines.append(" ".join(line_fields))
        field_index += take_count

    if field_index < len(fields):
        if lines:
            lines[-1] = f"{lines[-1]} {' '.join(fields[field_index:])}".strip()
        else:
            lines.append(" ".join(fields[field_index:]))

    return "\n".join(line for line in lines if line.strip()) or None


def wrap_text_for_box_precise(
    text: str,
    rect,
    fontsize: float,
    measure_font,
) -> str:
    normalized = normalize_text(text)
    if not normalized:
        return ""

    max_width = max(rect.width - 4, fontsize * 1.2)
    hanging_tolerance = max(fontsize * 0.7, 2.0)
    marker_tolerance = max(fontsize * 0.5, 1.5)
    lines: List[str] = []
    current = ""
    current_width = 0.0

    for token in tokenize_plain_text(normalized):
        token_text = token if current else token.lstrip()
        if not token_text:
            continue
        if current and is_leading_punctuation_token(token_text):
            lines.append(current.rstrip())
            current = token.lstrip()
            current_width = measure_text_width(measure_font, current, fontsize) if current else 0.0
            continue
        token_width = measure_text_width(measure_font, token_text, fontsize)
        if current and current_width + token_width > max_width:
            overflow = current_width + token_width - max_width
            if is_footnote_marker_token(token_text) and overflow <= marker_tolerance:
                current += token_text
                current_width += token_width
                continue
            if is_hanging_punctuation_token(token_text) and overflow <= hanging_tolerance:
                current += token_text
                current_width += token_width
                continue
            lines.append(current.rstrip())
            current = token.lstrip()
            current_width = measure_text_width(measure_font, current, fontsize) if current else 0.0
            continue
        current += token_text
        current_width += token_width

    if current.strip():
        lines.append(current.rstrip())

    return "\n".join(lines)


def wrap_text_by_source_line_breaks(
    text: str,
    block: Dict[str, Any],
    rect=None,
    fontsize: Optional[float] = None,
    measure_font=None,
) -> str:
    normalized = normalize_text(text)
    if not normalized:
        return ""

    layout_lines = block.get("layoutLines") or []
    source_lines = []
    for line in layout_lines:
        line_text = normalize_text("".join(str(item.get("text", "") or "") for item in line.get("items", [])))
        if line_text:
            source_lines.append(line_text)

    if len(source_lines) <= 1:
        return normalized

    if (
        block.get("blockType") == "metadata"
        and rect is not None
        and fontsize is not None
        and measure_font is not None
    ):
        compact_wrapped = wrap_compact_metadata_by_fields(normalized, block)
        if compact_wrapped:
            return compact_wrapped
        segments = split_metadata_marker_segments(normalized, block)
        if len(segments) > 1:
            wrapped_segments = [
                wrap_text_for_box_precise(segment, rect, fontsize, measure_font)
                for segment in segments
            ]
            return "\n".join(segment for segment in wrapped_segments if segment.strip())

    target_units = [max(estimate_text_units(line), 2.0) for line in source_lines]
    segments = [normalized]
    lines: List[str] = []
    line_index = 0

    for segment_index, segment in enumerate(segments):
        if not segment.strip():
            continue
        segment_tokens = tokenize_plain_text(segment)
        current = ""
        current_units = 0.0
        first_token_in_segment = True

        for token in segment_tokens:
            token_text = token if current else token.lstrip()
            if not token_text:
                continue
            token_units = estimate_text_units(token_text)
            current_limit = target_units[min(line_index, len(target_units) - 1)]
            remaining_lines = len(target_units) - line_index - 1

            if (
                current
                and current_units + token_units > current_limit
                and remaining_lines > 0
            ):
                overflow_units = current_units + token_units - current_limit
                if is_footnote_marker_token(token_text) and overflow_units <= 1.2:
                    current += token_text
                    current_units += token_units
                    first_token_in_segment = False
                    continue
                lines.append(current.rstrip())
                current = token.lstrip()
                current_units = estimate_text_units(current)
                line_index += 1
            else:
                current += token_text
                current_units += token_units
            first_token_in_segment = False

        if current.strip():
            lines.append(current.rstrip())
            if segment_index < len(segments) - 1 and line_index < len(target_units) - 1:
                line_index += 1

    return "\n".join(lines)


def should_preserve_source_line_breaks(
    block: Dict[str, Any],
    font_role: str,
) -> bool:
    if block.get("blockType") in ("heading", "caption", "metadata", "code", "other"):
        return True
    if block.get("role") == "heading":
        return True
    if font_role != "body":
        return True
    if not block.get("isBodyLike", False):
        return True

    layout_lines = block.get("layoutLines") or []
    if len(layout_lines) <= 1:
        return False
    return False


def placeholder_sort_key(value: str) -> int:
    match = re.search(r"(\d+)", value or "")
    return int(match.group(1)) if match else 0


def ordered_placeholder_keys(placeholders: Dict[str, Any]) -> List[str]:
    return sorted(placeholders.keys(), key=placeholder_sort_key)


def create_measure_font(fitz, font_options: Dict[str, Any]):
    fontfile = font_options.get("fontfile")
    fontname = font_options.get("fontname")
    if fontfile:
        try:
            return fitz.Font(fontfile=fontfile)
        except Exception:
            pass
    if fontname:
        try:
            return fitz.Font(fontname=fontname)
        except Exception:
            pass
    return fitz.Font(fontname="helv")


def measure_text_width(measure_font, text: str, font_size: float) -> float:
    if not text:
        return 0.0
    try:
        return float(measure_font.text_length(text, fontsize=font_size))
    except Exception:
        return estimate_text_units(text) * font_size * 0.62


def estimate_formula_placeholder_width(metadata: Dict[str, Any], font_size: float, block_font_size: float) -> float:
    bbox = metadata.get("bbox") or [0, 0, 0, 0]
    width = max(float(bbox[2]) - float(bbox[0]), 0.0) if len(bbox) == 4 else 0.0
    if width <= 0:
        fallback_text = str(metadata.get("text", "") or "")
        return estimate_text_units(fallback_text) * font_size * 0.62
    scale = font_size / max(block_font_size or 10.0, 1.0)
    return width * scale


def tokenize_mixed_text(
    text: str,
    placeholders: Dict[str, Any],
    font_size: float,
    block_font_size: float,
    measure_font,
) -> List[Dict[str, Any]]:
    tokens: List[Dict[str, Any]] = []
    parts = re.split(f"({INLINE_FORMULA_PLACEHOLDER_REGEX.pattern})", text)
    for part in parts:
        if not part:
            continue
        if part in placeholders:
            metadata = placeholders.get(part) or {}
            width = estimate_formula_placeholder_width(metadata, font_size, block_font_size)
            tokens.append(
                {
                    "type": "formula",
                    "key": part,
                    "text": str(metadata.get("text", "") or ""),
                    "width": width,
                    "spaceText": " " * max(int(round(width / max(font_size * 0.33, 1.5))), 1),
                }
            )
            continue
        for token in re.findall(
            r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[A-Za-z0-9_]+(?:['-][A-Za-z0-9_]+)*\s*|\s+|[^\s]",
            part,
        ):
            if not token:
                continue
            tokens.append(
                {
                    "type": "text",
                    "text": token,
                    "width": measure_text_width(measure_font, token, font_size),
                }
            )
    return tokens


def source_line_target_widths(block: Dict[str, Any], font_size: float, block_font_size: float) -> List[float]:
    widths: List[float] = []
    scale = font_size / max(block_font_size or 10.0, 1.0)
    for line in block.get("layoutLines") or []:
        total_width = 0.0
        for item in line.get("items", []):
            item_text = str(item.get("text", "") or "")
            if item.get("type") == "formula":
                bbox = item.get("bbox") or [0, 0, 0, 0]
                width = max(float(bbox[2]) - float(bbox[0]), 0.0) if len(bbox) == 4 else 0.0
                total_width += width * scale
            else:
                total_width += estimate_text_units(item_text) * font_size * 0.62
        if total_width > 0:
            widths.append(max(total_width, font_size * 1.2))
    return widths


def layout_mixed_tokens(
    text: str,
    block: Dict[str, Any],
    font_size: float,
    rect,
    preserve_source_breaks: bool,
    measure_font,
) -> List[List[Dict[str, Any]]]:
    placeholders = block.get("inlineFormulaPlaceholders") or {}
    block_font_size = float(block.get("fontSize") or font_size or 10)
    tokens = tokenize_mixed_text(text, placeholders, font_size, block_font_size, measure_font)
    if not tokens:
        return []

    if preserve_source_breaks:
        max_widths_per_line = source_line_target_widths(block, font_size, block_font_size)
        if not max_widths_per_line:
            preserve_source_breaks = False

    if not preserve_source_breaks:
        max_widths_per_line = [max(rect.width - 4, font_size * 1.2)]

    lines: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    current_width = 0.0
    line_index = 0

    for token in tokens:
        token_width = float(token["width"])
        line_limit = max_widths_per_line[min(line_index, len(max_widths_per_line) - 1)]
        can_wrap = (not preserve_source_breaks) or (line_index < len(max_widths_per_line) - 1)
        if current and current_width + token_width > line_limit and can_wrap:
            lines.append(current)
            current = []
            current_width = 0.0
            line_index += 1

        if token["type"] == "text":
            token = dict(token)
            token["text"] = token["text"].lstrip() if not current else token["text"]
            token["width"] = measure_text_width(measure_font, token["text"], font_size)
            token_width = float(token["width"])
            if not token["text"]:
                continue

        current.append(token)
        current_width += token_width

    if current:
        lines.append(current)

    return lines


def representative_font_size(sizes: List[float]) -> float:
    if not sizes:
        return 10.0
    rounded = [round(size, 1) for size in sizes if size > 0]
    if not rounded:
        return 10.0
    return float(statistics.median(rounded))


def dominant_font_size(sizes: List[float]) -> float:
    if not sizes:
        return 10.0
    rounded = [round(size, 1) for size in sizes if size > 0]
    if not rounded:
        return 10.0
    counts: Dict[float, int] = {}
    for size in rounded:
        counts[size] = counts.get(size, 0) + 1
    return max(counts.items(), key=lambda item: (item[1], item[0]))[0]


def looks_like_heading(text: str, font_size: float, page_body_font_size: float) -> bool:
    normalized = normalize_text(text)
    if not normalized or len(normalized) > 140:
        return False
    if SECTION_HEADING_REGEX.match(normalized):
        return True
    if font_size >= max(page_body_font_size * 1.18, page_body_font_size + 1.2):
        return True
    return False


def block_width(block: Dict[str, Any]) -> float:
    bbox = block.get("bbox") or [0, 0, 0, 0]
    if len(bbox) != 4:
        return 0.0
    return max(float(bbox[2]) - float(bbox[0]), 0.0)


def is_body_width_candidate(
    block: Dict[str, Any],
    page_body_font_size: float,
) -> bool:
    text = normalize_text(block.get("text") or "")
    if not text:
        return False
    if block.get("role") == "heading":
        return False
    if is_caption_like(text) or is_code_like(text):
        return False
    if has_private_use_garbage(text):
        return False
    if is_display_formula_block(block):
        return False

    width = block_width(block)
    page_width = max(float(block.get("pageWidth") or 1.0), 1.0)
    width_ratio = width / page_width
    if width_ratio < 0.18 or width_ratio > 0.86:
        return False

    font_size = float(block.get("fontSize") or 0.0)
    if font_size <= 0:
        return False
    if abs(font_size - page_body_font_size) > max(page_body_font_size * 0.22, 1.5):
        return False

    punctuation_count = len(re.findall(r"[，。；：.!?]", text))
    layout_line_count = len(block.get("layoutLines") or [])
    if len(text) >= 80 and punctuation_count >= 1:
        return True
    if len(text) >= 90 and layout_line_count >= 2:
        return True
    if len(text) >= 120:
        return True
    if layout_line_count >= 3 and len(text) >= 60 and punctuation_count >= 1:
        return True
    return False


def estimate_page_body_width(
    page_blocks: List[Dict[str, Any]],
    page_body_font_size: float,
) -> Optional[float]:
    candidate_blocks = [
        block
        for block in page_blocks
        if is_body_width_candidate(block, page_body_font_size)
    ]
    if not candidate_blocks:
        return None

    buckets: Dict[int, List[float]] = {}
    for block in candidate_blocks:
        width = block_width(block)
        bucket = int(round(width / 18.0))
        buckets.setdefault(bucket, []).append(width)

    best_widths = max(
        buckets.values(),
        key=lambda widths: (
            len(widths),
            sum(widths) / max(len(widths), 1),
        ),
    )
    if len(best_widths) >= 2:
        return float(statistics.median(best_widths))

    widths = [block_width(block) for block in candidate_blocks]
    return float(statistics.median(widths)) if widths else None


def is_body_like_block(
    block: Dict[str, Any],
    page_body_width: Optional[float],
    page_body_font_size: float,
) -> bool:
    text = normalize_text(block.get("text") or "")
    if not text:
        return False
    if block.get("role") == "heading":
        return False
    if is_caption_like(text) or is_code_like(text):
        return False
    if has_private_use_garbage(text):
        return False
    if is_display_formula_block(block):
        return False

    width = block_width(block)
    font_size = float(block.get("fontSize") or 0.0)
    if width <= 0 or font_size <= 0:
        return False

    if page_body_width is not None:
        width_delta = abs(width - page_body_width)
        if width_delta > max(page_body_width * 0.16, 24.0):
            return False
    else:
        page_width = max(float(block.get("pageWidth") or 1.0), 1.0)
        width_ratio = width / page_width
        if width_ratio < 0.3 or width_ratio > 0.86:
            return False

    if abs(font_size - page_body_font_size) > max(page_body_font_size * 0.22, 1.5):
        return False

    punctuation_count = len(re.findall(r"[，。；：.!?]", text))
    layout_line_count = len(block.get("layoutLines") or [])
    if len(text) >= 80 and punctuation_count >= 1:
        return True
    if len(text) >= 90 and layout_line_count >= 2:
        return True
    if len(text) >= 140:
        return True
    if layout_line_count >= 3 and len(text) >= 70 and punctuation_count >= 1:
        return True
    return False


def resolve_block_type(
    block: Dict[str, Any],
    page_body_width: Optional[float],
    page_body_font_size: float,
) -> str:
    docling_label = str(block.get("doclingLabel") or "")
    text = normalize_text(block.get("text") or "")
    body_like = is_body_like_block(block, page_body_width, page_body_font_size)

    if docling_label in ("title", "section_header"):
        return "heading"
    if docling_label == "caption":
        return "caption"
    if docling_label == "table":
        return "table_body"
    if docling_label == "formula":
        return "formula_display"
    if docling_label in (
        "footnote",
        "page_header",
        "page_footer",
        "reference",
        "document_index",
        "key_value_region",
        "field_region",
        "field_heading",
        "field_item",
        "field_key",
        "field_value",
        "field_hint",
    ):
        return "metadata"
    if docling_label in ("picture", "chart"):
        return "other"
    if docling_label in ("text", "paragraph", "list_item"):
        return "body" if body_like else "metadata"
    if is_arxiv_metadata_like(text):
        return "metadata"
    if is_code_like(text):
        return "code"
    if is_caption_like(text):
        return "caption"
    if block.get("role") == "heading":
        return "heading"
    if body_like:
        return "body"
    return "metadata"


def resolve_font_options(
    text: str,
    bold: bool = False,
    font_role: str = "body",
    preferred_style: str = "normal",
) -> Dict[str, Any]:
    if not contains_cjk(text):
        if preferred_style == "monospace" or font_role == "code":
            return {"fontname": "cour"}
        if preferred_style == "bold_italic":
            return {"fontname": "Times-BoldItalic"}
        if preferred_style == "italic":
            return {"fontname": "Times-Italic"}
        if preferred_style == "bold" or font_role == "heading":
            return {"fontname": "Times-Bold"}
        return {"fontname": "Times-Bold" if bold else "Times-Roman"}

    configured_font = os.environ.get("PDF_FONT_FILE") or os.environ.get("WASABI_PDF_FONT")
    role_candidates = {
        "body": [
            configured_font,
            r"C:\Windows\Fonts\simsun.ttc",
            r"C:\Windows\Fonts\SimSun-ExtB.ttf",
            r"C:\Windows\Fonts\NSimSun.ttf",
            r"C:\Windows\Fonts\STSONG.TTF",
            r"C:\Windows\Fonts\simfang.ttf",
            r"C:\Windows\Fonts\STFANGSO.TTF",
            r"C:\Windows\Fonts\FZJuZXFJW.TTF",
            r"C:\Windows\Fonts\SourceHanSerifSC-Regular.otf",
            r"C:\Windows\Fonts\NotoSerifCJKsc-Regular.otf",
            r"C:\Windows\Fonts\SourceHanSansSC-Regular.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Regular.otf",
            "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Regular.otf",
        ],
        "heading": [
            configured_font,
            r"C:\Windows\Fonts\simsun.ttc",
            r"C:\Windows\Fonts\STSONG.TTF",
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\msyhbd.ttc",
            r"C:\Windows\Fonts\simfang.ttf",
            r"C:\Windows\Fonts\STFANGSO.TTF",
            r"C:\Windows\Fonts\FZJuZXFJW.TTF",
            r"C:\Windows\Fonts\SourceHanSansSC-Bold.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Bold.otf",
            "/usr/share/fonts/opentype/adobe-source-han-sans/SourceHanSansSC-Bold.otf",
            "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Bold.otf",
        ],
        "caption": [
            configured_font,
            r"C:\Windows\Fonts\simsun.ttc",
            r"C:\Windows\Fonts\STSONG.TTF",
            r"C:\Windows\Fonts\simfang.ttf",
            r"C:\Windows\Fonts\STFANGSO.TTF",
            r"C:\Windows\Fonts\FZJuZXFJW.TTF",
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\SourceHanSansSC-Regular.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Regular.otf",
            "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Regular.otf",
            "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
        ],
        "code": [
            configured_font,
            r"C:\Windows\Fonts\consola.ttf",
            r"C:\Windows\Fonts\consolab.ttf",
            r"C:\Windows\Fonts\cour.ttf",
            "/usr/share/fonts/truetype/msttcorefonts/consola.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        ],
    }

    effective_role = "code" if preferred_style == "monospace" else font_role
    candidates = role_candidates.get(effective_role, role_candidates["body"])
    if bold and font_role == "body":
        candidates = [
            configured_font,
            r"C:\Windows\Fonts\simsun.ttc",
            r"C:\Windows\Fonts\STSONG.TTF",
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\msyhbd.ttc",
            r"C:\Windows\Fonts\simfang.ttf",
            r"C:\Windows\Fonts\STFANGSO.TTF",
            r"C:\Windows\Fonts\FZJuZXFJW.TTF",
            r"C:\Windows\Fonts\SourceHanSansSC-Bold.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Bold.otf",
        ] + candidates

    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return {"fontname": "cjk_fallback", "fontfile": candidate}

    return {"fontname": "cour" if preferred_style == "monospace" else ("helvB" if bold or preferred_style == "bold" else "helv")}


def direction_to_rotation(direction: Any) -> int:
    if not isinstance(direction, (list, tuple)) or len(direction) != 2:
        return 0

    dx = float(direction[0] or 0)
    dy = float(direction[1] or 0)
    if abs(dx) >= abs(dy):
        return 0 if dx >= 0 else 180
    return 90 if dy < 0 else 270


def bbox_intersects(a: List[float], b: List[float]) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return not (ax1 <= bx0 or bx1 <= ax0 or ay1 <= by0 or by1 <= ay0)


def bbox_intersection_area(a: List[float], b: List[float]) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0 = max(ax0, bx0)
    iy0 = max(ay0, by0)
    ix1 = min(ax1, bx1)
    iy1 = min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    return (ix1 - ix0) * (iy1 - iy0)


def bbox_area(bbox: List[float]) -> float:
    x0, y0, x1, y1 = bbox
    return max(x1 - x0, 0.0) * max(y1 - y0, 0.0)


def bbox_overlap_ratio(inner: List[float], outer: List[float]) -> float:
    area = bbox_area(inner)
    if area <= 0:
        return 0.0
    return bbox_intersection_area(inner, outer) / area


def docling_bbox_to_topleft(bbox_obj: Any, page_height: float) -> Optional[List[float]]:
    if bbox_obj is None:
        return None

    left = getattr(bbox_obj, "l", None)
    top = getattr(bbox_obj, "t", None)
    right = getattr(bbox_obj, "r", None)
    bottom = getattr(bbox_obj, "b", None)
    if None in (left, top, right, bottom):
        return None

    try:
        left_f = float(left)
        top_f = float(top)
        right_f = float(right)
        bottom_f = float(bottom)
    except Exception:
        return None

    # Docling prov boxes are bottom-left oriented for PDF.
    y0 = page_height - top_f
    y1 = page_height - bottom_f
    return [left_f, min(y0, y1), right_f, max(y0, y1)]


def extract_docling_layout_items(
    input_pdf: str,
    page_heights: Dict[int, float],
    pages: Optional[List[int]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    DocumentConverter = require_docling_converter()
    if DocumentConverter is None:
        return [], {"enabled": False, "status": "unavailable", "error": "docling_import_failed"}

    converter = DocumentConverter()
    batch_size = max(int(os.environ.get("WASABI_DOCLING_BATCH_PAGES", "5") or 5), 1)
    target_pages = sorted(set(pages or page_heights.keys()))
    page_batches = [
        target_pages[index : index + batch_size]
        for index in range(0, len(target_pages), batch_size)
    ]

    started_at = time.time()
    items: List[Dict[str, Any]] = []
    try:
        for batch_pages in page_batches:
            page_range: Tuple[int, int] = (min(batch_pages), max(batch_pages))
            result = converter.convert(Path(input_pdf).resolve(), page_range=page_range)
            for item, _level in result.document.iterate_items():
                label = getattr(item, "label", None)
                prov_list = getattr(item, "prov", None) or []
                if not prov_list:
                    continue

                text = normalize_text(getattr(item, "text", "") or "")
                for prov in prov_list:
                    page_no = int(getattr(prov, "page_no", 0) or 0)
                    if page_no <= 0:
                        continue
                    if page_no not in batch_pages:
                        continue
                    bbox = docling_bbox_to_topleft(
                        getattr(prov, "bbox", None),
                        page_heights.get(page_no, 0.0),
                    )
                    if not bbox:
                        continue
                    items.append(
                        {
                            "page": page_no,
                            "label": str(label.value if hasattr(label, "value") else label or ""),
                            "bbox": bbox,
                            "text": text,
                        }
                    )
    except Exception as exc:
        return [], {
            "enabled": False,
            "status": "failed",
            "error": str(exc),
            "elapsedMs": int((time.time() - started_at) * 1000),
            "batchPages": batch_size,
            "batches": len(page_batches),
        }
    return items, {
        "enabled": True,
        "status": "ok",
        "elapsedMs": int((time.time() - started_at) * 1000),
        "items": len(items),
        "batchPages": batch_size,
        "batches": len(page_batches),
    }


def text_token_overlap_ratio(a: str, b: str) -> float:
    tokens_a = set(re.findall(r"[A-Za-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]+", normalize_text(a).lower()))
    tokens_b = set(re.findall(r"[A-Za-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]+", normalize_text(b).lower()))
    if not tokens_a or not tokens_b:
        return 0.0
    intersection = len(tokens_a & tokens_b)
    return intersection / max(min(len(tokens_a), len(tokens_b)), 1)


def match_docling_item_to_block(
    block: Dict[str, Any],
    docling_items: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    best_item = None
    best_score = 0.0
    block_bbox = block.get("bbox") or [0, 0, 0, 0]
    block_text = block.get("text") or ""

    for item in docling_items:
        overlap = bbox_overlap_ratio(block_bbox, item["bbox"])
        if overlap <= 0.15:
            continue
        text_overlap = text_token_overlap_ratio(block_text, item.get("text", ""))
        score = overlap * 0.8 + text_overlap * 0.2
        if score > best_score:
            best_score = score
            best_item = item

    return best_item


def expand_bbox(a: List[float], b: List[float]) -> List[float]:
    return [
        min(a[0], b[0]),
        min(a[1], b[1]),
        max(a[2], b[2]),
        max(a[3], b[3]),
    ]


def is_table_caption(text: str) -> bool:
    normalized = normalize_text(text)
    return bool(re.match(r"^table\s+\d+[.:]?\s+", normalized, flags=re.IGNORECASE))


def is_figure_caption(text: str) -> bool:
    normalized = normalize_text(text)
    return bool(re.match(r"^(?:figure|fig\.)\s+\d+[.:]?\s+", normalized, flags=re.IGNORECASE))


def is_tableish_block(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False

    digit_count = len(re.findall(r"\d", normalized))
    upper_count = len(re.findall(r"[A-Z]", normalized))
    word_count = len(re.findall(r"[A-Za-z]{2,}", normalized))
    symbol_count = len(re.findall(r"[×·.=<>≤≥%/+\-]", normalized))

    if any(token in normalized for token in ("BLEU", "FLOPs", "EN-DE", "EN-FR")):
        return True
    if digit_count >= 4 and (word_count <= 10 or symbol_count >= 2):
        return True
    if upper_count >= 6 and word_count <= 8:
        return True
    return False


def detect_preserved_table_regions(page_blocks: List[Dict[str, Any]], page_width: float) -> List[List[float]]:
    if not page_blocks:
        return []

    caption_indexes = [
        index for index, block in enumerate(page_blocks) if is_table_caption(block["text"])
    ]
    if not caption_indexes:
        return []

    regions: List[List[float]] = []
    sorted_blocks = sorted(page_blocks, key=lambda block: (block["bbox"][1], block["bbox"][0]))

    for caption_index in caption_indexes:
        caption = page_blocks[caption_index]
        region = list(caption["bbox"])
        bottom_limit = caption["bbox"][3] + 260
        added = False

        for block in sorted_blocks:
            if block["id"] == caption["id"]:
                continue

            x0, y0, x1, y1 = block["bbox"]
            if y0 < caption["bbox"][1] - 8 or y0 > bottom_limit:
                continue

            width_ratio = (x1 - x0) / max(page_width, 1)
            intersects_x_band = x1 >= region[0] - 24 and x0 <= region[2] + 24
            if not intersects_x_band:
                continue

            text = block["text"]
            if is_tableish_block(text):
                region = expand_bbox(region, block["bbox"])
                added = True
                continue

            if added and len(normalize_text(text)) > 80 and width_ratio > 0.65:
                break

        if added:
            regions.append(region)

    return regions


def bbox_with_margin(bbox: List[float], margin: float) -> List[float]:
    return [bbox[0] - margin, bbox[1] - margin, bbox[2] + margin, bbox[3] + margin]


def overlaps_region_x(block: Dict[str, Any], x0: float, x1: float, margin: float = 0.0) -> bool:
    bx0, _, bx1, _ = block["bbox"]
    return bx1 >= x0 - margin and bx0 <= x1 + margin


def collect_blocks_in_region(
    page_blocks: List[Dict[str, Any]],
    region: List[float],
) -> List[Dict[str, Any]]:
    return [
        block
        for block in page_blocks
        if bbox_intersects(block["bbox"], region)
    ]


def is_short_or_tableish_block(block: Dict[str, Any]) -> bool:
    text = normalize_text(block["text"])
    if not text:
        return False
    if is_tableish_block(text):
        return True
    if len(text) <= 32 and len(re.findall(r"\d", text)) >= 1:
        return True
    if len(text) <= 24 and len(re.findall(r"[A-Za-z]{2,}", text)) <= 4:
        return True
    return False


def is_prose_like_block(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    return len(normalized) >= 70 and len(re.findall(r"[，。；：.!?]", normalized)) >= 1


def is_table_supporting_block(block: Dict[str, Any]) -> bool:
    text = normalize_text(block["text"])
    if not text:
        return False
    if is_table_caption(text) or is_tableish_block(text):
        return True
    if is_short_or_tableish_block(block) and not is_prose_like_block(text):
        return True
    return False


def is_table_body_block(block: Dict[str, Any]) -> bool:
    text = normalize_text(block.get("text") or "")
    if not text:
        return False
    if is_table_caption(text):
        return False
    if SECTION_HEADING_REGEX.match(text):
        return False
    if block.get("role") == "heading":
        return False
    if is_prose_like_block(text):
        return False
    if is_tableish_block(text):
        return True
    if is_short_or_tableish_block(block) and len(text) <= 48:
        return True
    return False


def is_figure_label_block(block: Dict[str, Any]) -> bool:
    text = normalize_text(block["text"])
    if not text or is_figure_caption(text) or is_table_caption(text):
        return False

    sentence_punct_count = len(re.findall(r"[，。；：.!?]", text))
    latin_words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
    cjk_chunks = re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]{2,}", text)
    token_count = len(re.findall(r"\S+", text))

    if re.search(r"<[^>]+>", text):
        return True
    if token_count <= 8 and sentence_punct_count == 0:
        return True
    if len(text) <= 42 and sentence_punct_count == 0 and len(latin_words) + len(cjk_chunks) <= 10:
        return True
    if len(text) <= 28 and len(re.findall(r"\d", text)) >= 1 and sentence_punct_count == 0:
        return True
    return False


def detect_preserved_figure_block_ids(
    page_blocks: List[Dict[str, Any]],
    page_width: float,
    page_height: float,
) -> Set[str]:
    preserved_ids: Set[str] = set()
    figure_captions = [block for block in page_blocks if is_figure_caption(block["text"])]
    if not figure_captions:
        return preserved_ids

    for caption in figure_captions:
        cx0, cy0, cx1, _ = caption["bbox"]
        region = [
            max(0.0, cx0 - 80),
            max(0.0, cy0 - min(page_height * 0.38, 280)),
            min(page_width, cx1 + 80),
            max(0.0, cy0 - 4),
        ]
        candidates = [
            block
            for block in page_blocks
            if block["id"] != caption["id"]
            and bbox_intersects(block["bbox"], region)
            and block["bbox"][3] <= cy0 - 2
            and is_figure_label_block(block)
        ]
        if len(candidates) < 4:
            continue
        for block in candidates:
            preserved_ids.add(block["id"])

    return preserved_ids


def build_layout_table_candidates(
    page_blocks: List[Dict[str, Any]],
    page_width: float,
) -> List[List[float]]:
    candidates: List[List[float]] = []
    relevant = [block for block in page_blocks if is_short_or_tableish_block(block)]
    if len(relevant) < 5:
        return candidates

    relevant.sort(key=lambda block: (block["bbox"][1], block["bbox"][0]))
    groups: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []

    for block in relevant:
        if not current:
            current = [block]
            continue

        prev = current[-1]
        y_gap = block["bbox"][1] - prev["bbox"][3]
        if y_gap <= 24:
            current.append(block)
        else:
            groups.append(current)
            current = [block]

    if current:
        groups.append(current)

    for group in groups:
        if len(group) < 5:
            continue
        x0 = min(block["bbox"][0] for block in group)
        y0 = min(block["bbox"][1] for block in group)
        x1 = max(block["bbox"][2] for block in group)
        y1 = max(block["bbox"][3] for block in group)
        width_ratio = (x1 - x0) / max(page_width, 1)
        if width_ratio < 0.28 or width_ratio > 0.9:
            continue

        row_buckets = sorted(
            {
                round(((block["bbox"][1] + block["bbox"][3]) / 2.0) / 10.0) * 10.0
                for block in group
            }
        )
        col_buckets = sorted(
            {
                round(block["bbox"][0] / 18.0) * 18.0
                for block in group
            }
        )
        if len(row_buckets) < 3 or len(col_buckets) < 3:
            continue

        candidates.append(bbox_with_margin([x0, y0, x1, y1], 4))

    return candidates


def build_table_candidate_regions(
    page,
    page_blocks: List[Dict[str, Any]],
    page_width: float,
) -> List[List[float]]:
    candidates: List[List[float]] = []

    # Caption-driven candidates.
    for caption in page_blocks:
        if not is_table_caption(caption["text"]):
            continue

        cx0, cy0, cx1, cy1 = caption["bbox"]
        candidate = [max(0, cx0 - 24), cy1 - 2, min(page_width, cx1 + 24), cy1 + 260]

        related_blocks = [
            block
            for block in page_blocks
            if block["id"] != caption["id"]
            and overlaps_region_x(block, candidate[0], candidate[2], margin=12)
            and block["bbox"][1] >= cy1 - 6
            and block["bbox"][1] <= cy1 + 260
        ]
        if related_blocks:
            tableish = [block for block in related_blocks if is_table_body_block(block)]
            if tableish:
                region = list(tableish[0]["bbox"])
                for block in tableish:
                    region = expand_bbox(region, block["bbox"])
                candidates.append(bbox_with_margin(region, 4))

    # Horizontal-rule-driven candidates.
    segments = extract_horizontal_rule_segments(page)
    for cluster in cluster_horizontal_segments(segments):
        if len(cluster) < 3:
            continue
        ys = sorted(item[1] for item in cluster)
        x0 = min(item[0] for item in cluster)
        x1 = max(item[2] for item in cluster)
        width_ratio = (x1 - x0) / max(page_width, 1)
        if width_ratio < 0.4:
            continue
        region = [x0 - 3, ys[0] - 8, x1 + 3, ys[-1] + 8]
        candidates.append(bbox_with_margin(region, 3))

    candidates.extend(build_layout_table_candidates(page_blocks, page_width))

    return candidates


def score_table_candidate(
    candidate_region: List[float],
    page_blocks: List[Dict[str, Any]],
    horizontal_segments: List[List[float]],
    page_width: float,
) -> float:
    candidate_blocks = collect_blocks_in_region(page_blocks, candidate_region)
    if not candidate_blocks:
        return 0.0

    texts = [normalize_text(block["text"]) for block in candidate_blocks]
    non_empty_texts = [text for text in texts if text]
    if not non_empty_texts:
        return 0.0

    line_count = sum(
        1
        for x0, y, x1 in horizontal_segments
        if x0 >= candidate_region[0] - 8
        and x1 <= candidate_region[2] + 8
        and candidate_region[1] - 8 <= y <= candidate_region[3] + 8
    )
    short_block_count = sum(1 for text in non_empty_texts if len(text) <= 24)
    tableish_block_count = sum(1 for text in non_empty_texts if is_tableish_block(text))
    caption_count = sum(1 for text in non_empty_texts if is_table_caption(text))
    numeric_rich_count = sum(1 for text in non_empty_texts if len(re.findall(r"\d", text)) >= 2)
    prose_like_count = sum(
        1
        for text in non_empty_texts
        if len(text) >= 70 and len(re.findall(r"[，。；：.!?]", text)) >= 1
    )

    row_positions = sorted(
        {
            round((block["bbox"][1] + block["bbox"][3]) / 2.0, 0)
            for block in candidate_blocks
            if len(normalize_text(block["text"])) > 0
        }
    )
    col_positions = sorted(
        {
            round(block["bbox"][0] / 12.0) * 12.0
            for block in candidate_blocks
            if len(normalize_text(block["text"])) > 0
        }
    )

    score = 0.0
    score += min(line_count, 8) * 1.3
    score += min(tableish_block_count, 8) * 1.2
    score += min(short_block_count, 10) * 0.35
    score += min(numeric_rich_count, 8) * 0.35
    score += min(caption_count, 1) * 3.0
    if len(row_positions) >= 4:
        score += 2.0
    if len(col_positions) >= 3:
        score += 2.0
    if len(candidate_blocks) >= 6:
        score += 1.0
    score -= prose_like_count * 2.2

    # Penalize huge loose regions that look more like body text than a compact table.
    width_ratio = (candidate_region[2] - candidate_region[0]) / max(page_width, 1)
    if width_ratio > 0.85 and prose_like_count >= 2:
        score -= 2.5

    return score


def refine_table_region(
    candidate_region: List[float],
    page_blocks: List[Dict[str, Any]],
    horizontal_segments: List[List[float]],
) -> Optional[List[float]]:
    candidate_blocks = collect_blocks_in_region(page_blocks, candidate_region)
    supporting_blocks = [block for block in candidate_blocks if is_table_body_block(block)]
    if not supporting_blocks:
        return None

    refined = list(supporting_blocks[0]["bbox"])
    for block in supporting_blocks[1:]:
        refined = expand_bbox(refined, block["bbox"])

    line_segments = [
        [x0, y, x1]
        for x0, y, x1 in horizontal_segments
        if x1 >= refined[0] - 8
        and x0 <= refined[2] + 8
        and refined[1] - 16 <= y <= refined[3] + 16
    ]
    if line_segments:
        refined = expand_bbox(
            refined,
            [
                min(item[0] for item in line_segments),
                min(item[1] for item in line_segments),
                max(item[2] for item in line_segments),
                max(item[1] for item in line_segments),
            ],
        )

    return bbox_with_margin(refined, 4)


def detect_scored_table_regions(
    page,
    page_blocks: List[Dict[str, Any]],
    page_width: float,
) -> List[List[float]]:
    horizontal_segments = extract_horizontal_rule_segments(page)
    candidates = build_table_candidate_regions(page, page_blocks, page_width)
    accepted: List[List[float]] = []

    scored_candidates = []
    for region in candidates:
        score = score_table_candidate(region, page_blocks, horizontal_segments, page_width)
        if score >= 6.0:
            refined = refine_table_region(region, page_blocks, horizontal_segments)
            if refined:
                scored_candidates.append((score, refined))

    for _, region in sorted(scored_candidates, key=lambda item: item[0], reverse=True):
        merged = False
        for index, existing in enumerate(accepted):
            if bbox_intersects(existing, region):
                accepted[index] = expand_bbox(existing, region)
                merged = True
                break
        if not merged:
            accepted.append(region)

    return accepted


def extract_horizontal_rule_segments(page) -> List[List[float]]:
    segments: List[List[float]] = []
    for drawing in page.get_drawings():
        for item in drawing.get("items", []):
            if not item or item[0] != "l":
                continue
            p1, p2 = item[1], item[2]
            dx = abs(float(p2.x) - float(p1.x))
            dy = abs(float(p2.y) - float(p1.y))
            if dx < 40 or dy > 1.5:
                continue
            segments.append(
                [
                    min(float(p1.x), float(p2.x)),
                    (float(p1.y) + float(p2.y)) / 2.0,
                    max(float(p1.x), float(p2.x)),
                ]
            )
    return segments


def cluster_horizontal_segments(
    segments: List[List[float]],
    x_tolerance: float = 10.0,
) -> List[List[List[float]]]:
    clusters: List[List[List[float]]] = []
    for segment in sorted(segments, key=lambda item: (item[0], item[2], item[1])):
        x0, y, x1 = segment
        matched_cluster = None
        for cluster in clusters:
            cx0 = sum(item[0] for item in cluster) / len(cluster)
            cx1 = sum(item[2] for item in cluster) / len(cluster)
            if abs(x0 - cx0) <= x_tolerance and abs(x1 - cx1) <= x_tolerance:
                matched_cluster = cluster
                break
        if matched_cluster is None:
            matched_cluster = []
            clusters.append(matched_cluster)
        matched_cluster.append(segment)
    return clusters


def find_caption_above_region(
    page_blocks: List[Dict[str, Any]],
    x0: float,
    x1: float,
    top_y: float,
) -> Optional[Dict[str, Any]]:
    candidates = []
    for block in page_blocks:
        bx0, by0, bx1, by1 = block["bbox"]
        overlaps_x = bx1 >= x0 - 16 and bx0 <= x1 + 16
        if not overlaps_x or by1 > top_y + 2:
            continue
        if top_y - by1 > 90:
            continue
        if is_table_caption(block["text"]):
            candidates.append(block)
    if not candidates:
        return None
    return max(candidates, key=lambda block: block["bbox"][3])


def detect_line_based_table_regions(
    page,
    page_blocks: List[Dict[str, Any]],
    page_width: float,
) -> List[List[float]]:
    segments = extract_horizontal_rule_segments(page)
    if len(segments) < 3:
        return []

    regions: List[List[float]] = []
    for cluster in cluster_horizontal_segments(segments):
        if len(cluster) < 3:
            continue

        ys = sorted(item[1] for item in cluster)
        x0 = min(item[0] for item in cluster)
        x1 = max(item[2] for item in cluster)
        if (x1 - x0) / max(page_width, 1) < 0.45:
            continue
        if ys[-1] - ys[0] < 20:
            continue

        region = [x0 - 3, ys[0] - 6, x1 + 3, ys[-1] + 6]
        caption = find_caption_above_region(page_blocks, x0, x1, ys[0])
        if caption:
            region = expand_bbox(region, caption["bbox"])

        supporting_blocks = [
            block
            for block in page_blocks
            if bbox_intersects(block["bbox"], region)
            and (is_tableish_block(block["text"]) or is_table_caption(block["text"]))
        ]
        if caption or len(supporting_blocks) >= 3:
            regions.append(region)

    return regions


def signature_text(text: str) -> str:
    normalized = normalize_text(text).lower()
    normalized = re.sub(r"\d+", "#", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip()


def is_repeated_signature_candidate(text: str) -> bool:
    normalized = normalize_text(text)
    if len(normalized) < 3:
        return False
    if len(normalized) > 160:
        return False
    if re.fullmatch(r"[\d\s./-]+", normalized):
        return False
    return True


def is_page_number_block(block: Dict[str, Any]) -> bool:
    text = normalize_text(block["text"])
    return bool(re.fullmatch(r"\d{1,3}", text))


def is_margin_metadata_block(block: Dict[str, Any]) -> bool:
    text = normalize_text(block["text"])
    if not text:
        return False
    if "arxiv" in text.lower():
        return True
    if re.search(r"\[[A-Za-z.:-]+\]", text) and re.search(r"\d{4}", text):
        return True
    if re.search(r"\b(?:cs|math|stat|econ|q-bio|hep|astro-ph)\.[A-Z-]+\b", text, flags=re.IGNORECASE):
        return True
    return False


def is_side_marginalia_block(block: Dict[str, Any]) -> bool:
    x0, y0, x1, y1 = block["bbox"]
    page_width = max(float(block["pageWidth"] or 1), 1.0)
    page_height = max(float(block["pageHeight"] or 1), 1.0)
    width_ratio = (x1 - x0) / page_width
    height_ratio = (y1 - y0) / page_height
    is_left_margin = x1 <= page_width * 0.14
    is_right_margin = x0 >= page_width * 0.86
    is_rotated = int(block.get("rotation") or 0) in (90, 270)
    return (
        (is_left_margin or is_right_margin)
        and width_ratio <= 0.12
        and (height_ratio >= 0.14 or is_rotated or len(normalize_text(block["text"])) >= 18)
    )


def detect_preserved_peripheral_block_ids(
    pages_blocks: List[List[Dict[str, Any]]],
) -> Set[str]:
    top_signatures: Dict[str, Set[int]] = {}
    bottom_signatures: Dict[str, Set[int]] = {}
    side_signatures: Dict[str, Set[int]] = {}
    preserved_ids: Set[str] = set()

    for page_blocks in pages_blocks:
        for block in page_blocks:
            text = block["text"]
            signature = signature_text(text)
            if not is_repeated_signature_candidate(signature):
                continue

            x0, y0, x1, y1 = block["bbox"]
            page_height = max(float(block["pageHeight"] or 1), 1.0)

            if y1 <= page_height * 0.11:
                top_signatures.setdefault(signature, set()).add(block["page"])
            if y0 >= page_height * 0.89:
                bottom_signatures.setdefault(signature, set()).add(block["page"])
            if is_side_marginalia_block(block):
                side_signatures.setdefault(signature, set()).add(block["page"])

    repeated_top = {sig for sig, pages in top_signatures.items() if len(pages) >= 2}
    repeated_bottom = {sig for sig, pages in bottom_signatures.items() if len(pages) >= 2}
    repeated_side = {sig for sig, pages in side_signatures.items() if len(pages) >= 2}

    for page_blocks in pages_blocks:
        for block in page_blocks:
            text = block["text"]
            signature = signature_text(text)
            x0, y0, x1, y1 = block["bbox"]
            page_height = max(float(block["pageHeight"] or 1), 1.0)

            if signature in repeated_top and y1 <= page_height * 0.11:
                preserved_ids.add(block["id"])
                continue
            if signature in repeated_bottom and y0 >= page_height * 0.89:
                preserved_ids.add(block["id"])
                continue
            if signature in repeated_side and is_side_marginalia_block(block):
                preserved_ids.add(block["id"])
                continue
            if is_side_marginalia_block(block) and is_margin_metadata_block(block):
                preserved_ids.add(block["id"])
                continue
            if is_page_number_block(block) and (
                y1 <= page_height * 0.08 or y0 >= page_height * 0.92
            ):
                preserved_ids.add(block["id"])

    return preserved_ids


def parse_pages(value: str) -> List[int]:
    pages: Set[int] = set()
    for raw_part in value.split(","):
        part = raw_part.strip()
        if not part:
            raise argparse.ArgumentTypeError("Empty segment in --pages selector.")

        if "-" in part:
            start_text, end_text = [segment.strip() for segment in part.split("-", 1)]
            if not start_text.isdigit() or not end_text.isdigit():
                raise argparse.ArgumentTypeError(
                    f'Invalid page range "{part}". Use positive integers like 2-4.'
                )
            start = int(start_text)
            end = int(end_text)
            if start <= 0 or end <= 0 or start > end:
                raise argparse.ArgumentTypeError(
                    f'Invalid page range "{part}". Start must be <= end and both must be positive.'
                )
            for page in range(start, end + 1):
                pages.add(page)
            continue

        if not part.isdigit() or int(part) <= 0:
            raise argparse.ArgumentTypeError(
                f'Invalid page "{part}". Use positive integers like 1,3,5.'
            )
        pages.add(int(part))

    return sorted(pages)


def extract_blocks(input_pdf: str, output_json: str, pages: Optional[List[int]] = None) -> None:
    fitz = require_fitz()
    doc = fitz.open(input_pdf)
    pages_blocks: List[List[Dict[str, Any]]] = []
    page_heights = {
        page_index + 1: float(doc[page_index].rect.height)
        for page_index in range(len(doc))
    }
    docling_items, docling_summary = extract_docling_layout_items(input_pdf, page_heights, pages=pages)
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
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                line_text = normalize_text("".join(span.get("text", "") for span in spans))
                if line_text:
                    lines.append(line_text)
                    rotations.append(direction_to_rotation(line.get("dir")))
                line_items = []
                for span in spans:
                    size = float(span.get("size", 0) or 0)
                    max_font_size = max(max_font_size, size)
                    if size > 0:
                        span_sizes.append(size)
                block_font_size = dominant_font_size(span_sizes) if span_sizes else 10.0
                for span in spans:
                    span_text = str(span.get("text", "") or "")
                    if not span_text:
                        continue
                    span_bbox = [float(v) for v in span.get("bbox", [0, 0, 0, 0])]
                    span_flags = int(span.get("flags", 0) or 0)
                    span_flag_hints = decode_span_flags(span_flags)
                    block_flag_values.add(span_flags)
                    block_has_italic = block_has_italic or span_flag_hints["isItalicLike"]
                    block_has_monospace = block_has_monospace or span_flag_hints["isMonospaceLike"]
                    block_has_bold = block_has_bold or span_flag_hints["isBoldLike"]
                    block_has_superscript = block_has_superscript or span_flag_hints["isSuperscriptLike"]
                    line_items.append(
                        {
                            "type": "formula" if is_formula_span(span, block_font_size) else "text",
                            "text": span_text,
                            "bbox": span_bbox,
                            "font": str(span.get("font", "") or ""),
                            "size": float(span.get("size", 0) or 0),
                            "flags": span_flags,
                            **span_flag_hints,
                        }
                    )
                merged_items = merge_span_items(line_items)
                if merged_items:
                    layout_lines.append(
                        {
                            "bbox": [float(v) for v in line.get("bbox", [0, 0, 0, 0])],
                            "items": merged_items,
                        }
                    )

            text = normalize_text("\n".join(lines))
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
                    "fontSize": dominant_font_size(span_sizes),
                    "medianFontSize": representative_font_size(span_sizes),
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
                    "text": text,
                }
            )

        body_font_candidates = [
            float(block["fontSize"])
            for block in page_blocks
            if 6 <= float(block["fontSize"]) <= 14 and len(normalize_text(block["text"])) >= 20
        ]
        page_body_font_size = (
            float(statistics.median(body_font_candidates))
            if body_font_candidates
            else 10.0
        )

        for block in page_blocks:
            matched_docling_item = match_docling_item_to_block(
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
                block["role"] = "heading"
                block["fontSize"] = max(float(block["fontSize"]), page_body_font_size + 1.0)
            elif looks_like_heading(block["text"], float(block["fontSize"]), page_body_font_size):
                block["role"] = "heading"
                block["fontSize"] = max(float(block["fontSize"]), page_body_font_size + 1.0)

        page_body_width = estimate_page_body_width(page_blocks, page_body_font_size)
        for block in page_blocks:
            block["pageBodyFontSize"] = page_body_font_size
            block["pageBodyWidth"] = page_body_width
            block["isBodyLike"] = is_body_like_block(
                block,
                page_body_width,
                page_body_font_size,
            )
            block["blockType"] = resolve_block_type(
                block,
                page_body_width,
                page_body_font_size,
            )
            block["preferredTextStyle"] = get_preferred_text_style(
                block,
                get_font_role(block),
                bool(block.get("role") == "heading"),
            )

        preserved_regions = detect_scored_table_regions(page, page_blocks, page_width)
        preserved_figure_ids = detect_preserved_figure_block_ids(
            page_blocks,
            page_width,
            page_height,
        )
        for block in page_blocks:
            if block["id"] in preserved_figure_ids:
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "figure_label"
                block["blockType"] = "other"
            elif any(
                bbox_overlap_ratio(block["bbox"], region) >= 0.6
                and is_table_body_block(block)
                for region in preserved_regions
            ):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "table_region"
                block["blockType"] = "table_body"
            elif has_private_use_garbage(block["text"]):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "garbled_text"
                block["blockType"] = "other"
            elif is_display_formula_block(block):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "display_formula"
                block["blockType"] = "formula_display"
            elif is_formula_heavy_text(block["text"]):
                if block.get("blockType") != "body":
                    block["preserveOriginal"] = True
                    block["role"] = "preserved"
                    block["preserveReason"] = "formula_heavy"
                    block["blockType"] = "formula_display"
        pages_blocks.append(page_blocks)

    preserved_peripheral_ids = detect_preserved_peripheral_block_ids(pages_blocks)
    blocks: List[Dict[str, Any]] = []
    for page_blocks in pages_blocks:
        for block in page_blocks:
            if block["id"] in preserved_peripheral_ids:
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block.setdefault("preserveReason", "peripheral_repeat")
            blocks.append(block)

    payload = {
        "version": PDF_BLOCKS_SCHEMA_VERSION,
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


def fit_textbox(
    page,
    rect,
    text: str,
    block: Dict[str, Any],
    font_size: float,
    rotation: int,
    fitz,
    bold: bool = False,
    min_font_size: float = 5.0,
    font_role: str = "body",
    debug_visuals: bool = False,
) -> bool:
    # Start from the extracted size so the result stays visually closer to the source.
    size = max(min(font_size or 10, 36), min_font_size)
    preferred_style = get_preferred_text_style(block, font_role, bold)
    font_options = resolve_font_options(
        text,
        bold=bold,
        font_role=font_role,
        preferred_style=preferred_style,
    )
    measure_font = create_measure_font(fitz, font_options)
    preserve_source_breaks = should_preserve_source_line_breaks(block, font_role)
    layout_lines = block.get("layoutLines") or []

    # Very thin single-line blocks are more reliable with direct baseline text placement
    # than with insert_textbox, especially for CJK fonts near the rect height limit.
    if rotation == 0 and len(layout_lines) <= 1 and rect.height <= max((font_size or 10) * 1.15, 12):
        single_line = normalize_text(text)
        while size >= min_font_size:
            line_width = measure_text_width(measure_font, single_line, size)
            ascender = float(getattr(measure_font, "ascender", 1.0) or 1.0)
            descender = abs(float(getattr(measure_font, "descender", -0.2) or -0.2))
            line_height = size * max(ascender + descender, 1.0)
            if line_width <= rect.width - 2 and line_height <= rect.height + 1:
                baseline_y = rect.y0 + size * ascender
                page.insert_text(
                    (rect.x0 + 1.0, baseline_y),
                    single_line,
                    fontsize=size,
                    color=(0, 0, 0),
                    **font_options,
                )
                return True
            size -= 0.5

    while size >= min_font_size:
        wrapped = (
            wrap_text_by_source_line_breaks(text, block, rect, size, measure_font)
            if preserve_source_breaks
            else wrap_text_for_box_precise(text, rect, size, measure_font)
        )
        if preserve_source_breaks and (block.get("hasMonospaceLike") or block.get("hasBoldLike")):
            logical_lines = wrapped.splitlines()
            if logical_lines:
                max_line_width = 0.0
                for line_index, line_text in enumerate(logical_lines):
                    style = get_source_line_style(block, line_index, font_role, bold)
                    line_font_options = resolve_font_options(
                        line_text,
                        bold=bool(style["bold"]),
                        font_role=str(style["font_role"]),
                        preferred_style=str(style["preferred_style"]),
                    )
                    line_measure_font = create_measure_font(fitz, line_font_options)
                    max_line_width = max(
                        max_line_width,
                        measure_text_width(line_measure_font, line_text, size),
                    )
                lineheight = 1.05 if bold else 1.1
                total_height = len(logical_lines) * size * lineheight
                if max_line_width <= rect.width - 2 and total_height <= rect.height + 1:
                    ascender_default = float(getattr(measure_font, "ascender", 1.0) or 1.0)
                    for line_index, line_text in enumerate(logical_lines):
                        style = get_source_line_style(block, line_index, font_role, bold)
                        line_font_options = resolve_font_options(
                            line_text,
                            bold=bool(style["bold"]),
                            font_role=str(style["font_role"]),
                            preferred_style=str(style["preferred_style"]),
                        )
                        line_measure_font = create_measure_font(fitz, line_font_options)
                        ascender = float(getattr(line_measure_font, "ascender", ascender_default) or ascender_default)
                        baseline_y = rect.y0 + line_index * size * lineheight + size * ascender
                        page.insert_text(
                            (rect.x0 + 1.0, baseline_y),
                            line_text,
                            fontsize=size,
                            color=(0, 0, 0),
                            **line_font_options,
                        )
                    return True
        overflow = page.insert_textbox(
            rect,
            wrapped,
            fontsize=size,
            color=(0, 0, 0),
            align=fitz.TEXT_ALIGN_LEFT,
            rotate=rotation,
            lineheight=1.05 if bold else 1.1,
            **font_options,
        )
        if overflow >= 0:
            return True
        # Remove the failed insertion by redrawing a white rectangle before retry.
        page.draw_rect(
            rect,
            fill=(1, 1, 1),
            color=(1, 1, 1) if debug_visuals else None,
            width=0.7 if debug_visuals else 0,
            overlay=True,
        )
        size -= 0.5

    fallback_size = max(min(min_font_size, font_size or 10), 3.0)
    try:
        wrapped = (
            wrap_text_by_source_line_breaks(text, block, rect, fallback_size, measure_font)
            if preserve_source_breaks
            else wrap_text_for_box_precise(text, rect, fallback_size, measure_font)
        )
        overflow = page.insert_textbox(
            rect,
            wrapped,
            fontsize=fallback_size,
            color=(0, 0, 0),
            align=fitz.TEXT_ALIGN_LEFT,
            rotate=rotation,
            lineheight=1.0,
            **font_options,
        )
        if overflow >= 0:
            return True
    except Exception:
        pass
    return False


def replace_inline_formula_placeholders(
    text: str,
    block: Dict[str, Any],
    font_size: float,
    use_literal: bool = False,
) -> str:
    placeholders = block.get("inlineFormulaPlaceholders") or {}
    if not placeholders:
        return text

    def replacement(match: re.Match[str]) -> str:
        key = match.group(0)
        metadata = placeholders.get(key)
        literal = metadata.get("text", "") if isinstance(metadata, dict) else str(metadata or "")
        if use_literal and literal:
            return literal
        if isinstance(metadata, dict):
            bbox = metadata.get("bbox") or [0, 0, 0, 0]
            width = max(float(bbox[2]) - float(bbox[0]), 0.0) if len(bbox) == 4 else 0.0
        else:
            width = 0.0
        if width <= 0:
            return literal or " "
        estimated_space_width = max(font_size * 0.33, 1.5)
        space_count = max(int(round(width / estimated_space_width)), 1)
        return " " * space_count

    return INLINE_FORMULA_PLACEHOLDER_REGEX.sub(replacement, text)


def should_use_mixed_textbox(block: Dict[str, Any]) -> bool:
    placeholders = block.get("inlineFormulaPlaceholders") or {}
    if not placeholders:
        return False
    return block.get("blockType") == "body"


def redact_block_text_preserving_inline_formulas(page, block: Dict[str, Any], fitz) -> bool:
    layout_lines = block.get("layoutLines") or []
    redact_count = 0
    for line in layout_lines:
        for item in line.get("items", []):
            if item.get("type") != "text":
                continue
            item_text = normalize_text(item.get("text") or "")
            if not item_text:
                continue
            rect = fitz.Rect(*item.get("bbox", [0, 0, 0, 0]))
            if rect.is_empty or rect.is_infinite:
                continue
            page.add_redact_annot(rect, fill=(1, 1, 1))
            redact_count += 1
    if redact_count <= 0:
        return False
    page.apply_redactions()
    return True


def render_inline_formula_clips(
    page,
    source_doc,
    source_page_number: int,
    lines: List[List[Dict[str, Any]]],
    block: Dict[str, Any],
    rect,
    font_size: float,
    lineheight: float,
):
    placeholders = block.get("inlineFormulaPlaceholders") or {}
    if not placeholders:
        return

    block_font_size = float(block.get("fontSize") or font_size or 10.0)
    line_tops = [rect.y0 + index * font_size * lineheight for index in range(len(lines))]
    x_start = rect.x0 + 1.0

    for line_index, line in enumerate(lines):
        current_x = x_start
        line_top = line_tops[line_index]
        for token in line:
            if token["type"] != "formula":
                current_x += float(token.get("width", 0.0))
                continue

            metadata = placeholders.get(token.get("key"))
            if not isinstance(metadata, dict):
                current_x += float(token.get("width", 0.0))
                continue

            bbox = metadata.get("bbox") or [0, 0, 0, 0]
            line_bbox = metadata.get("lineBBox") or bbox
            if len(bbox) != 4 or len(line_bbox) != 4:
                current_x += float(token.get("width", 0.0))
                continue

            scale = font_size / max(block_font_size or 10.0, 1.0)
            source_page = source_doc[source_page_number]
            rect_type = page.rect.__class__
            clip = source_page.rect & rect_type(*bbox)
            dest_rect = rect_type(
                current_x,
                line_top + (float(bbox[1]) - float(line_bbox[1])) * scale,
                current_x + (float(bbox[2]) - float(bbox[0])) * scale,
                line_top + (float(bbox[3]) - float(line_bbox[1])) * scale,
            )
            if not clip.is_empty and not dest_rect.is_empty:
                page.show_pdf_page(dest_rect, source_doc, source_page_number, clip=clip, overlay=True)
            current_x += float(token.get("width", 0.0))


def render_text_layout(
    shape,
    lines: List[List[Dict[str, Any]]],
    rect,
    font_size: float,
    lineheight: float,
    measure_font,
    **font_options,
):
    ascender = float(getattr(measure_font, "ascender", 1.0) or 1.0)
    line_tops = [rect.y0 + index * font_size * lineheight for index in range(len(lines))]
    x_start = rect.x0 + 1.0

    for line_index, line in enumerate(lines):
        current_x = x_start
        baseline_y = line_tops[line_index] + font_size * ascender
        for token in line:
            if token["type"] == "formula":
                current_x += float(token.get("width", 0.0))
                continue
            token_text = str(token.get("text", "") or "")
            if token_text:
                shape.insert_text(
                    (current_x, baseline_y),
                    token_text,
                    fontsize=font_size,
                    **font_options,
                )
            current_x += float(token.get("width", 0.0))


def fit_mixed_textbox(
    page,
    source_doc,
    rect,
    text: str,
    block: Dict[str, Any],
    font_size: float,
    rotation: int,
    fitz,
    bold: bool = False,
    min_font_size: float = 5.0,
    font_role: str = "body",
    debug_visuals: bool = False,
    redact_before_write: bool = True,
) -> bool:
    if rotation != 0:
        return False

    if not should_use_mixed_textbox(block):
        return False

    size = max(min(font_size or 10, 36), min_font_size)
    preserve_source_breaks = should_preserve_source_line_breaks(block, font_role)
    preferred_style = get_preferred_text_style(block, font_role, bold)
    font_options = resolve_font_options(
        text,
        bold=bold,
        font_role=font_role,
        preferred_style=preferred_style,
    )
    measure_font = create_measure_font(fitz, font_options)
    lineheight = 1.05 if bold else 1.1
    source_page_number = max(int(block.get("page", 1)) - 1, 0)

    while size >= min_font_size:
        lines = layout_mixed_tokens(text, block, size, rect, preserve_source_breaks, measure_font)
        if not lines:
            return False

        total_height = len(lines) * size * lineheight
        if total_height > rect.height + 1:
            size -= 0.5
            continue

        shape = page.new_shape()
        render_text_layout(
            shape,
            lines,
            rect,
            size,
            lineheight,
            measure_font,
            color=(0, 0, 0),
            **font_options,
        )

        if redact_before_write:
            page.add_redact_annot(rect, fill=(1, 1, 1))
            page.apply_redactions()
        shape.commit(overlay=True)
        render_inline_formula_clips(
            page,
            source_doc,
            source_page_number,
            lines,
            block,
            rect,
            size,
            lineheight,
        )
        return True

    return False


def write_translated_block(
    page,
    block: Dict[str, Any],
    fitz,
    *,
    source_doc=None,
    erase_mode: str = "redact",
    debug_visuals: bool = False,
) -> Optional[bool]:
    rect = fitz.Rect(*block.get("bbox", [0, 0, 0, 0]))
    if rect.is_empty or rect.is_infinite:
        return None

    if block.get("preserveOriginal"):
        if erase_mode == "none" and source_doc is not None:
            source_page_number = max(int(block.get("page", 1)) - 1, 0)
            clip = source_doc[source_page_number].rect & rect
            if clip.is_empty:
                return False
            page.show_pdf_page(rect, source_doc, source_page_number, clip=clip, overlay=True)
            return True
        return None

    translated = sanitize_translated_text(block.get("translatedText") or "")
    if not translated:
        return None

    rotation = int(block.get("rotation") or 0)
    bold = block.get("role") == "heading"
    font_role = get_font_role(block)
    base_font_size = float(block.get("fontSize") or 10)
    if bold:
        min_font_size = 5.5
    elif block.get("hasSizeJump"):
        min_font_size = 4.8
    else:
        min_font_size = 4.5

    can_use_mixed = should_use_mixed_textbox(block) and source_doc is not None
    success = False

    if can_use_mixed:
        success = fit_mixed_textbox(
            page,
            source_doc,
            rect,
            translated,
            block,
            base_font_size,
            rotation,
            fitz,
            bold=bold,
            min_font_size=min_font_size,
            font_role=font_role,
            debug_visuals=debug_visuals,
            redact_before_write=(erase_mode == "redact"),
        )

    if not success:
        use_literal_inline = (
            erase_mode == "none"
            or source_doc is None
            or block.get("blockType") != "body"
        )
        translated = replace_inline_formula_placeholders(
            translated,
            block,
            base_font_size,
            use_literal=use_literal_inline,
        )
        if erase_mode == "redact":
            preserved_inline = (
                False
                if use_literal_inline
                else redact_block_text_preserving_inline_formulas(page, block, fitz)
            )
            if not preserved_inline:
                page.add_redact_annot(rect, fill=(1, 1, 1))
                page.apply_redactions()
        success = fit_textbox(
            page,
            rect,
            translated,
            block,
            base_font_size,
            rotation,
            fitz,
            bold=bold,
            min_font_size=min_font_size,
            font_role=font_role,
            debug_visuals=debug_visuals,
        )

    return success


def fill_rebuilt_pdf(input_pdf: str, translated_json: str, output_pdf: str) -> None:
    fitz = require_fitz()
    payload = json.loads(Path(translated_json).read_text(encoding="utf-8"))
    written = 0
    failed = 0
    preserved = 0
    blocks_by_page: Dict[int, List[Dict[str, Any]]] = {}
    for block in payload.get("blocks", []):
        page_number = int(block.get("page", 0)) - 1
        blocks_by_page.setdefault(page_number, []).append(block)

    def render_text_callback(src_page, dst_page, page_index: int) -> None:
        nonlocal written, failed, preserved
        for block in blocks_by_page.get(page_index, []):
            result = write_translated_block(
                dst_page,
                block,
                fitz,
                source_doc=src_page.parent,
                erase_mode="none",
                debug_visuals=False,
            )
            if result is None:
                continue
            if result:
                if block.get("preserveOriginal"):
                    preserved += 1
                else:
                    written += 1
            else:
                failed += 1
                preview_source = (
                    block.get("text")
                    if block.get("preserveOriginal")
                    else sanitize_translated_text(block.get("translatedText") or "")
                )
                preview = normalize_text(preview_source or "")[:80]
                print(
                    f"WARN: rebuilt write failed for {block.get('id')} on page {block.get('page')} "
                    f"bbox={block.get('bbox')} text={preview!r}",
                )

    stats = rebuild_pdf_graphic_layers(
        input_pdf=input_pdf,
        output_pdf=output_pdf,
        options=RebuildOptions(
            rebuild_vectors=True,
            rebuild_images=True,
            rebuild_links=True,
            min_drawing_area=0,
            verbose=True,
        ),
        render_text_callback=render_text_callback,
    )
    print(
        f"Filled rebuilt PDF: {output_pdf} "
        f"(written={written}, preserved={preserved}, failed={failed}, "
        f"drawings={stats.drawings}, skipped_drawings={stats.skipped_drawings}, "
        f"images={stats.images}, placements={stats.image_placements}, "
        f"smask_images={stats.images_with_smask}, "
        f"skipped_images={stats.skipped_images}, links={stats.links})"
    )


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="Wasabi PDF extraction/backfill helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    extract_parser = subparsers.add_parser("extract", help="extract PDF text blocks to JSON")
    extract_parser.add_argument("input_pdf")
    extract_parser.add_argument("output_json")
    extract_parser.add_argument("--pages", type=parse_pages, default=None)

    fill_parser = subparsers.add_parser("fill", help="fill translated JSON text back into PDF")
    fill_parser.add_argument("input_pdf")
    fill_parser.add_argument("translated_json")
    fill_parser.add_argument("output_pdf")

    args = parser.parse_args(argv)
    if args.command == "extract":
        extract_blocks(args.input_pdf, args.output_json, args.pages)
    elif args.command == "fill":
        fill_rebuilt_pdf(args.input_pdf, args.translated_json, args.output_pdf)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
