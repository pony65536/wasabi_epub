#!/usr/bin/env python3
"""PDF JSON extraction and translated text backfill for Wasabi.

This helper intentionally does not translate. Node/Wasabi owns translation;
Python only extracts structured JSON text blocks and writes translated text back
into a copy of the PDF.

Requires PyMuPDF:
    python3 -m pip install pymupdf
"""

from __future__ import annotations

import json
import math
import os
import re
import statistics
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

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


TRANSLATION_NOTE_PATTERNS = [
    re.compile(r"^[（(]?\s*(?:注|NOTE)\s*[:：]", flags=re.IGNORECASE),
    re.compile(r"\bnode[_\s-]?\d+\b", flags=re.IGNORECASE),
    re.compile(r"\bsid\b", flags=re.IGNORECASE),
    re.compile(r"(?:按规则|严格保留|不合并|不调整|原文此处编号有误)"),
]


def is_translation_meta_note(value: str) -> bool:
    normalized = sanitize_translated_text(value)
    if not normalized:
        return False
    match_count = sum(1 for pattern in TRANSLATION_NOTE_PATTERNS if pattern.search(normalized))
    if match_count >= 2:
        return True
    if match_count >= 1 and len(normalized) <= 120 and normalized[:1] in {"（", "(", "["}:
        return True
    return False


def is_orphan_punctuation_translation(block: Dict[str, Any], value: str) -> bool:
    normalized = sanitize_translated_text(value)
    if not normalized:
        return False
    if not bool(block.get("_proseHeadingSequence")):
        return False
    if not bool(block.get("_demotedFromHeading")):
        return False
    if not re.fullmatch(r'[\s"“”‘’\'.,;:!?！？。，；：()（）\[\]{}-]+', normalized):
        return False

    source_text = normalize_text(block.get("text") or "")
    if len(source_text) < 8:
        return False
    if not re.search(r"[A-Za-z\u3400-\u4dbf\u4e00-\u9fff]", source_text):
        return False
    return True


def pdf_int_color_to_rgb(value: Any) -> Tuple[float, float, float]:
    try:
        color_int = int(value or 0)
    except Exception:
        color_int = 0
    return (
        ((color_int >> 16) & 255) / 255.0,
        ((color_int >> 8) & 255) / 255.0,
        (color_int & 255) / 255.0,
    )


AUTHOR_METADATA_PAREN_NAME_REGEX = re.compile(
    r"(?<=[\u3400-\u4dbf\u4e00-\u9fff·])\s*[（(][A-Za-zÀ-ÖØ-öø-ÿ0-9.\-'\s]+[)）]"
)


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
HANGING_PUNCTUATION = set("、，。；：！？…）》】」』〕〉%.,;:!?)]}”’")
LEADING_PUNCTUATION = set("（【《〈「『〔“‘([<{")
RUNNING_HEADER_LABEL_REGEX = re.compile(r"^[A-Z][A-Z\s/&-]{0,23}$")
ARXIV_METADATA_REGEX = re.compile(
    r"^arxiv:\d{4}\.\d{4,5}(?:v\d+)?\s+\[[A-Za-z.\-]+\]\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}$",
    flags=re.IGNORECASE,
)
PDF_BLOCKS_SCHEMA_VERSION = 2
CJK_FONT_TEXT_REGEX = re.compile(
    r"[\u00b7\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]"
)
MEASURE_FONT_CACHE: Dict[Tuple[Optional[str], Optional[str]], Any] = {}
TEXT_WIDTH_CACHE: Dict[Tuple[Tuple[Optional[str], Optional[str]], float, str], float] = {}
TEXT_WIDTH_CACHE_MAX_ENTRIES = 50000


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


def requires_cjk_font(text: str) -> bool:
    return bool(CJK_FONT_TEXT_REGEX.search(text or ""))


def detect_geometric_script_offset(
    span_bbox: List[float],
    line_bbox: List[float],
    span_size: float,
    block_font_size: float,
) -> Dict[str, bool]:
    if len(span_bbox) != 4 or len(line_bbox) != 4:
        return {"geomSuperscriptLike": False, "geomSubscriptLike": False}
    if span_size <= 0 or block_font_size <= 0:
        return {"geomSuperscriptLike": False, "geomSubscriptLike": False}

    line_top = float(line_bbox[1])
    line_bottom = float(line_bbox[3])
    span_top = float(span_bbox[1])
    span_bottom = float(span_bbox[3])
    line_height = max(line_bottom - line_top, 1.0)
    size_ratio = span_size / max(block_font_size, 1.0)

    if size_ratio > 0.92:
        return {"geomSuperscriptLike": False, "geomSubscriptLike": False}

    top_shift = (span_top - line_top) / line_height
    bottom_shift = (line_bottom - span_bottom) / line_height
    geom_superscript = top_shift >= 0.10 and bottom_shift >= 0.18
    geom_subscript = top_shift <= -0.02 and bottom_shift <= -0.10

    return {
        "geomSuperscriptLike": bool(geom_superscript),
        "geomSubscriptLike": bool(geom_subscript),
    }


def require_docling_converter():
    try:
        from docling.document_converter import DocumentConverter  # type: ignore
    except ImportError:
        return None
    return DocumentConverter


def require_pikepdf():
    try:
        import pikepdf  # type: ignore
        from pikepdf import models  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "pikepdf is required for stripping PDF text while preserving original graphics. "
            "Install it with: python -m pip install pikepdf"
        ) from exc
    return pikepdf, models


def resolve_font_options(*args, **kwargs):
    from domain import layout as _layout

    return _layout.resolve_font_options(*args, **kwargs)


def direction_to_rotation(direction: Any) -> int:
    from domain import layout as _layout

    return _layout.direction_to_rotation(direction)


def bbox_intersects(a: List[float], b: List[float]) -> bool:
    from domain import layout as _layout

    return _layout.bbox_intersects(a, b)


def bbox_intersection_area(a: List[float], b: List[float]) -> float:
    from domain import layout as _layout

    return _layout.bbox_intersection_area(a, b)


def bbox_area(bbox: List[float]) -> float:
    from domain import layout as _layout

    return _layout.bbox_area(bbox)


def bbox_overlap_ratio(inner: List[float], outer: List[float]) -> float:
    from domain import layout as _layout

    return _layout.bbox_overlap_ratio(inner, outer)


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


def is_footnote_block(block: Dict[str, Any]) -> bool:
    return str(block.get("blockType") or "") == "footnote" or str(block.get("doclingLabel") or "") == "footnote"


def is_author_metadata_block(block: Dict[str, Any]) -> bool:
    text = normalize_text(block.get("text") or "")
    if not text or "@" not in text:
        return False
    if str(block.get("blockType") or "") not in {"metadata", "page_header", "page_footer"} and str(block.get("doclingLabel") or "") not in {"text", "list_item", "key_value_region", "field_region"}:
        return False
    layout_lines = block.get("layoutLines") or []
    if len(layout_lines) < 2 or len(layout_lines) > 4:
        return False
    if len(text) >= 160:
        return False
    non_empty_lines = []
    for line in layout_lines:
        items = line.get("items", []) or []
        line_text = normalize_text("".join(str(item.get("text", "") or "") for item in items))
        if line_text:
            non_empty_lines.append({"text": line_text, "items": items})
    if len(non_empty_lines) < 2 or len(non_empty_lines) > 4:
        return False

    first_items = non_empty_lines[0]["items"]
    first_text_items = [item for item in first_items if item.get("type") == "text" and normalize_text(str(item.get("text", "") or ""))]
    if not first_text_items:
        return False
    first_text = normalize_text(non_empty_lines[0]["text"])
    if len(re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ]+", first_text)) < 2:
        return False
    if not any(bool(item.get("isBoldLike")) for item in first_text_items):
        return False
    if len(re.findall(r"\S+", first_text)) > 6:
        return False

    last_text = normalize_text(non_empty_lines[-1]["text"])
    if "@" not in last_text:
        return False
    if not re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", last_text):
        return False

    last_items = non_empty_lines[-1]["items"]
    last_text_items = [item for item in last_items if item.get("type") == "text" and normalize_text(str(item.get("text", "") or ""))]
    if not last_text_items:
        return False
    if not any(bool(item.get("isMonospaceLike")) for item in last_text_items):
        return False

    if len(non_empty_lines) == 2:
        return True

    for line in non_empty_lines[1:-1]:
        middle_text = normalize_text(line["text"])
        middle_items = line["items"]
        middle_text_items = [item for item in middle_items if item.get("type") == "text" and normalize_text(str(item.get("text", "") or ""))]
        if not middle_text_items:
            return False
        if "@" in middle_text:
            return False
        if len(re.findall(r"\S+", middle_text)) > 8:
            return False
        if len(re.findall(r"[，。；：.!?]", middle_text)) > 1:
            return False
        if any(bool(item.get("isMonospaceLike")) for item in middle_text_items):
            return False
    return True


def build_author_metadata_restore_regions(page_blocks: List[Dict[str, Any]]) -> List[List[float]]:
    author_blocks = [block for block in page_blocks if is_author_metadata_block(block)]
    if not author_blocks:
        return []

    author_boxes = [list(block.get("bbox") or [0, 0, 0, 0]) for block in author_blocks if len(block.get("bbox") or []) == 4]
    region = union_bboxes(author_boxes)
    if region is None:
        return []
    return [bbox_with_margin(region, 2.0)]


def get_font_role(block: Dict[str, Any]) -> str:
    block_type = str(block.get("blockType") or "")
    if block_type == "code":
        return "code"
    if block_type == "caption":
        return "caption"
    if block_type == "heading":
        return "heading"
    if is_footnote_block(block):
        return "body"
    if block_type in ("reference_block", "metadata", "page_header", "page_footer"):
        return "metadata"
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
    if font_role == "heading" or bold:
        return "bold"
    return "normal"


def infer_family_class_from_font_name(font_name: str) -> str:
    normalized = str(font_name or "").lower()
    if not normalized:
        return "serif"
    if any(token in normalized for token in ("cour", "mono", "tt", "typewriter", "consol", "code")):
        return "mono"
    if any(token in normalized for token in ("helv", "arial", "sans", "goth", "hei", "grotesk", "msyh")):
        return "sans"
    if any(token in normalized for token in ("times", "nimbusrom", "roman", "serif", "song", "ming", "fang", "kai")):
        return "serif"
    return "serif"


def item_family_class(item: Dict[str, Any], default_font_role: str = "body") -> str:
    if bool(item.get("isMonospaceLike")) or default_font_role == "code":
        return "mono"
    font_name = str(item.get("font", "") or "")
    inferred = infer_family_class_from_font_name(font_name)
    if inferred != "serif" or font_name:
        return inferred
    if bool(item.get("isSerifLike")):
        return "serif"
    return "serif"


def items_family_class(items: List[Dict[str, Any]], default_font_role: str = "body") -> str:
    counts: Dict[str, int] = {}
    for item in items:
        if item.get("type") != "text":
            continue
        item_text = normalize_text(str(item.get("text", "") or ""))
        if not item_text:
            continue
        family_class = item_family_class(item, default_font_role)
        counts[family_class] = counts.get(family_class, 0) + 1
    if not counts:
        return "mono" if default_font_role == "code" else "serif"
    return max(counts.items(), key=lambda item: item[1])[0]


def block_style_family_class(block: Dict[str, Any], default_font_role: str = "body") -> str:
    render_style = block.get("_renderDefaultStyle")
    if isinstance(render_style, dict) and render_style.get("familyClass"):
        return str(render_style.get("familyClass"))
    default_style = block.get("defaultStyle")
    if isinstance(default_style, dict) and default_style.get("familyClass"):
        return str(default_style.get("familyClass"))
    layout_lines = block.get("layoutLines") or []
    text_items: List[Dict[str, Any]] = []
    for line in layout_lines:
        for item in line.get("items", []) or []:
            if item.get("type") == "text" and normalize_text(str(item.get("text", "") or "")):
                text_items.append(item)
    return items_family_class(text_items, default_font_role)


def build_block_default_style(block: Dict[str, Any]) -> Dict[str, Any]:
    font_role = get_font_role(block)
    bold = bool(block.get("role") == "heading" or str(block.get("blockType") or "") == "heading")
    preferred_style = get_preferred_text_style(block, font_role, bold)
    default_style = {
        "fontRole": font_role,
        "familyClass": block_style_family_class(block, font_role),
        "weight": "bold" if preferred_style in {"bold", "bold_italic"} or bold else "regular",
        "italic": preferred_style in {"italic", "bold_italic"},
        "mono": preferred_style == "monospace" or font_role == "code",
    }
    block["defaultStyle"] = default_style
    return default_style


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
            "family_class": block_style_family_class(block, default_font_role),
        }

    items = layout_lines[line_index].get("items", []) or []
    text_items = [item for item in items if item.get("type") == "text" and normalize_text(str(item.get("text", "") or ""))]
    if not text_items:
        return {
            "font_role": default_font_role,
            "bold": default_bold,
            "preferred_style": get_preferred_text_style(block, default_font_role, default_bold),
            "family_class": block_style_family_class(block, default_font_role),
        }

    monospace_only = all(bool(item.get("isMonospaceLike")) for item in text_items)
    has_bold = any(bool(item.get("isBoldLike")) for item in text_items)
    has_italic = any(bool(item.get("isItalicLike")) for item in text_items)
    has_superscript = any(bool(item.get("isSuperscriptLike")) for item in text_items)
    line_text = normalize_text("".join(str(item.get("text", "") or "") for item in text_items))
    if monospace_only:
        return {"font_role": "code", "bold": False, "preferred_style": "monospace", "family_class": "mono"}
    if has_italic:
        preferred_style = "bold_italic" if has_bold else "italic"
        return {
            "font_role": default_font_role,
            "bold": bool(has_bold or default_bold),
            "preferred_style": preferred_style,
            "family_class": items_family_class(text_items, default_font_role),
        }
    if has_bold:
        return {
            "font_role": default_font_role,
            "bold": True,
            "preferred_style": "bold",
            "family_class": items_family_class(text_items, default_font_role),
        }
    if has_superscript and default_font_role == "metadata":
        return {
            "font_role": default_font_role,
            "bold": default_bold,
            "preferred_style": get_preferred_text_style(block, default_font_role, default_bold),
            "family_class": items_family_class(text_items, default_font_role),
        }
    return {
        "font_role": default_font_role,
        "bold": default_bold,
        "preferred_style": get_preferred_text_style(block, default_font_role, default_bold),
        "family_class": items_family_class(text_items, default_font_role),
    }


def source_item_visual_style(
    item: Dict[str, Any],
    block: Dict[str, Any],
    default_font_role: str,
) -> Dict[str, Any]:
    monospace = bool(item.get("isMonospaceLike"))
    bold = bool(item.get("isBoldLike"))
    italic = bool(item.get("isItalicLike"))
    if monospace:
        font_role = "code"
        preferred_style = "monospace"
        family_class = "mono"
        bold = False
    else:
        font_role = default_font_role
        if italic and bold:
            preferred_style = "bold_italic"
        elif italic:
            preferred_style = "italic"
        elif bold:
            preferred_style = "bold"
        else:
            preferred_style = get_preferred_text_style(block, default_font_role, False)
        family_class = item_family_class(item, default_font_role)
    return {
        "font_role": font_role,
        "bold": bold,
        "preferred_style": preferred_style,
        "family_class": family_class,
        "font_size": float(item.get("size", 0) or 0),
        "color": tuple(float(v) for v in (item.get("color") or (0.0, 0.0, 0.0))),
    }


def source_visual_signature(style: Dict[str, Any]) -> Tuple[Any, ...]:
    return (
        str(style.get("font_role") or ""),
        bool(style.get("bold")),
        str(style.get("preferred_style") or ""),
        str(style.get("family_class") or ""),
        round(float(style.get("font_size") or 0.0), 2),
        tuple(round(float(v), 6) for v in (style.get("color") or (0.0, 0.0, 0.0))),
    )


def block_has_uniform_visual_style(block: Dict[str, Any]) -> bool:
    layout_lines = block.get("layoutLines") or []
    default_font_role = get_font_role(block)
    signatures: Set[Tuple[Any, ...]] = set()
    for line in layout_lines:
        for item in line.get("items", []) or []:
            if item.get("type") != "text" or not normalize_text(str(item.get("text", "") or "")):
                continue
            signatures.add(source_visual_signature(source_item_visual_style(item, block, default_font_role)))
            if len(signatures) > 1:
                return False
    return len(signatures) == 1


def block_primary_text_color(block: Dict[str, Any]) -> Tuple[float, float, float]:
    weighted: Dict[Tuple[float, float, float], int] = {}
    for line in block.get("layoutLines") or []:
        for item in line.get("items", []) or []:
            if item.get("type") != "text":
                continue
            item_text = normalize_text(str(item.get("text", "") or ""))
            if not item_text:
                continue
            color = tuple(round(float(v), 6) for v in (item.get("color") or (0.0, 0.0, 0.0)))
            weighted[color] = weighted.get(color, 0) + max(len(item_text), 1)
    if not weighted:
        return (0.0, 0.0, 0.0)
    return max(weighted.items(), key=lambda item: item[1])[0]


def line_has_uniform_visual_style(block: Dict[str, Any], line: Dict[str, Any]) -> bool:
    default_font_role = get_font_role(block)
    signatures: Set[Tuple[Any, ...]] = set()
    for item in line.get("items", []) or []:
        if item.get("type") != "text" or not normalize_text(str(item.get("text", "") or "")):
            continue
        signatures.add(source_visual_signature(source_item_visual_style(item, block, default_font_role)))
        if len(signatures) > 1:
            return False
    return len(signatures) == 1


def split_text_by_weights(text: str, weights: List[int]) -> List[str]:
    if not weights:
        return [text]
    if sum(max(weight, 0) for weight in weights) <= 0:
        return [text] + [""] * (len(weights) - 1)
    compact = text or ""
    total_chars = len(compact)
    if total_chars <= 0:
        return [""] * len(weights)

    total_weight = float(sum(max(weight, 0) for weight in weights))
    parts: List[str] = []
    cursor = 0
    for index, weight in enumerate(weights):
        if index == len(weights) - 1:
            parts.append(compact[cursor:])
            break
        share = max(weight, 0) / total_weight
        next_cursor = cursor + int(round(total_chars * share))
        remaining_slots = len(weights) - index - 1
        next_cursor = min(max(next_cursor, cursor), total_chars - remaining_slots)
        parts.append(compact[cursor:next_cursor])
        cursor = next_cursor
    while len(parts) < len(weights):
        parts.append("")
    return parts


def wrap_styled_segments_to_width(
    fitz,
    segments: List[Dict[str, Any]],
    max_width: float,
    block: Dict[str, Any],
    line_index: int,
) -> List[List[Dict[str, Any]]]:
    if not segments:
        return [[]]

    wrapped_lines: List[List[Dict[str, Any]]] = [[]]
    current_width = 0.0

    def clone_segment(segment: Dict[str, Any], text: str, width: float) -> Dict[str, Any]:
        cloned = dict(segment)
        cloned["text"] = text
        cloned["width"] = width
        return cloned

    for segment in segments:
        seg_text = str(segment.get("text") or "")
        seg_width = float(segment.get("width") or 0.0)
        if not seg_text:
            continue

        if current_width + seg_width <= max_width or not wrapped_lines[-1]:
            wrapped_lines[-1].append(segment)
            current_width += seg_width
            continue

        remaining_text = seg_text
        font_options = dict(segment["font_options"])
        while remaining_text:
            available = max(max_width - current_width, 0.0)
            if available <= 0.0:
                wrapped_lines.append([])
                current_width = 0.0
                available = max_width

            candidate = ""
            candidate_width = 0.0
            index = 0
            while index < len(remaining_text):
                next_candidate = remaining_text[: index + 1]
                next_width = measure_script_split_line_width(
                    fitz,
                    next_candidate,
                    float(segment["font_size"]),
                    font_options,
                    str(segment["font_role"]),
                    bool(segment["bold"]),
                    str(segment["preferred_style"]),
                    block=block,
                    line_index=line_index,
                )
                if next_width > available and candidate:
                    break
                if next_width > available and not candidate:
                    candidate = next_candidate
                    candidate_width = next_width
                    index += 1
                    break
                candidate = next_candidate
                candidate_width = next_width
                index += 1

            wrapped_lines[-1].append(clone_segment(segment, candidate, candidate_width))
            current_width += candidate_width
            remaining_text = remaining_text[len(candidate):]
            if remaining_text:
                wrapped_lines.append([])
                current_width = 0.0

    return wrapped_lines


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
            tuple(round(float(v), 6) for v in (item.get("color") or (0.0, 0.0, 0.0))),
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


def footnote_markers_are_separate_source_lines(block: Dict[str, Any]) -> bool:
    if not is_footnote_block(block):
        return False
    layout_lines = block.get("layoutLines") or []
    if len(layout_lines) < 2:
        return False
    for line in layout_lines[1:]:
        items = line.get("items", []) or []
        if not items:
            continue
        first_text = normalize_text(str(items[0].get("text", "") or ""))
        if not is_footnote_marker_token(first_text):
            continue
        if len(items) >= 2 and normalize_text(str(items[1].get("text", "") or "")):
            return True
    return False


def matching_formula_layout_item(
    block: Dict[str, Any],
    metadata: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    target_bbox = metadata.get("bbox") or [0, 0, 0, 0]
    target_text = normalize_text(str(metadata.get("text", "") or ""))
    if len(target_bbox) != 4:
        return None
    tx0, ty0, tx1, ty1 = [float(v) for v in target_bbox]
    for line in block.get("layoutLines") or []:
        for item in line.get("items", []) or []:
            if item.get("type") != "formula":
                continue
            item_bbox = item.get("bbox") or [0, 0, 0, 0]
            if len(item_bbox) != 4:
                continue
            ix0, iy0, ix1, iy1 = [float(v) for v in item_bbox]
            if (
                abs(ix0 - tx0) <= 0.8
                and abs(iy0 - ty0) <= 0.8
                and abs(ix1 - tx1) <= 0.8
                and abs(iy1 - ty1) <= 0.8
            ):
                return item
            if target_text and normalize_text(str(item.get("text", "") or "")) == target_text:
                if abs(ix0 - tx0) <= 2.0 and abs(iy0 - ty0) <= 2.0:
                    return item
    return None


def is_preservable_formula_metadata(
    block: Dict[str, Any],
    metadata: Dict[str, Any],
) -> bool:
    metadata_font = str(metadata.get("font", "") or "")
    if metadata_font and MATH_FONT_REGEX.search(metadata_font):
        return True
    item = matching_formula_layout_item(block, metadata)
    if not isinstance(item, dict):
        return False
    font_name = str(item.get("font", "") or "")
    return bool(MATH_FONT_REGEX.search(font_name))


def preservable_formula_placeholder_queues(block: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    placeholders = block.get("inlineFormulaPlaceholders") or {}
    queues: Dict[str, List[Dict[str, Any]]] = {}
    for metadata in placeholders.values():
        if not isinstance(metadata, dict):
            continue
        placeholder_text = normalize_text(str(metadata.get("text", "") or ""))
        if not placeholder_text:
            continue
        if not is_preservable_formula_metadata(block, metadata):
            continue
        queues.setdefault(placeholder_text, []).append(metadata)
    for _, items in queues.items():
        items.sort(
            key=lambda item: (
                float((item.get("lineBBox") or item.get("bbox") or [0, 0, 0, 0])[1]),
                float((item.get("bbox") or [0, 0, 0, 0])[0]),
            )
        )
    return queues


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


def wrap_author_metadata_by_source_roles(text: str, block: Dict[str, Any]) -> Optional[str]:
    normalized = normalize_text(text)
    if not normalized or "@" not in normalized:
        return None

    layout_lines = block.get("layoutLines") or []
    if len(layout_lines) < 2 or len(layout_lines) > 4:
        return None

    source_lines = []
    for line in layout_lines:
        items = line.get("items", []) or []
        line_text = normalize_text("".join(str(item.get("text", "") or "") for item in items))
        if line_text:
            source_lines.append({"text": line_text, "items": items})
    if len(source_lines) < 2 or len(source_lines) > 4:
        return None
    if not any("@" in line["text"] for line in source_lines):
        return None

    email_match = re.search(r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*$", normalized)
    if not email_match:
        return None
    email_text = email_match.group(1)
    prefix = normalized[: email_match.start()].rstrip(" ，,;；:")
    if not prefix:
        return None

    email_line_index = next(
        (index for index, line in enumerate(source_lines) if "@" in line["text"]),
        len(source_lines) - 1,
    )
    pre_email_lines = source_lines[:email_line_index]
    if not pre_email_lines:
        return None

    expected_affiliation_tokens = 0
    if len(pre_email_lines) >= 2:
        expected_affiliation_tokens = len(re.findall(r"\S+", pre_email_lines[-1]["text"]))

    fields = re.findall(r"\S+", prefix)
    if len(fields) < 2:
        return None

    if expected_affiliation_tokens >= 1 and len(fields) > expected_affiliation_tokens:
        affiliation_count = expected_affiliation_tokens
    else:
        affiliation_count = 1
    affiliation_count = min(max(affiliation_count, 1), len(fields) - 1)

    name_line = " ".join(fields[:-affiliation_count]).strip()
    affiliation_line = " ".join(fields[-affiliation_count:]).strip()
    if not name_line or not affiliation_line:
        return None

    rendered_lines = [name_line]
    if len(pre_email_lines) >= 2:
        rendered_lines.append(affiliation_line)
    else:
        rendered_lines[0] = f"{name_line} {affiliation_line}".strip()
    rendered_lines.append(email_text)
    return "\n".join(line for line in rendered_lines if line)


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
    if "@" in normalized:
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


def should_use_body_bbox_wrap(block: Dict[str, Any], font_role: str) -> bool:
    return (
        font_role == "body"
        and bool(block.get("isBodyLike"))
        and (str(block.get("blockType") or "") == "body" or is_footnote_block(block))
    )


def has_irregular_body_wrap_shape(block: Optional[Dict[str, Any]]) -> bool:
    wrap_shape = str((block or {}).get("wrapShape") or "regular")
    return wrap_shape in {"inset_left", "inset_right"}


def has_dynamic_body_line_bounds(block: Optional[Dict[str, Any]]) -> bool:
    templates = normalize_wrap_line_templates(block)
    if len(templates) < 2:
        return False

    offsets = [float(template["xOffset"]) for template in templates]
    widths = [float(template["width"]) for template in templates]
    if not widths:
        return False

    max_offset = max(offsets) if offsets else 0.0
    min_offset = min(offsets) if offsets else 0.0
    max_width = max(widths)
    min_width = min(widths)
    width_variation = max_width - min_width

    if max_offset - min_offset >= 8.0:
        return True
    if max_offset >= 8.0:
        return True
    if width_variation >= max(18.0, max_width * 0.08):
        return True
    return False


def normalize_wrap_line_templates(block: Optional[Dict[str, Any]]) -> List[Dict[str, float]]:
    templates = (block or {}).get("wrapLineTemplates") or []
    layout_lines = (block or {}).get("layoutLines") or []
    bbox = (block or {}).get("bbox") or [0.0, 0.0, 0.0, 0.0]
    try:
        base_x0 = float(bbox[0])
        base_y0 = float(bbox[1])
    except Exception:
        base_x0 = 0.0
        base_y0 = 0.0
    normalized_templates: List[Dict[str, float]] = []
    max_count = max(len(templates), len(layout_lines))
    for index in range(max_count):
        template = templates[index] if index < len(templates) else {}
        line = layout_lines[index] if index < len(layout_lines) else {}
        try:
            x_offset = max(float(template.get("xOffset") or 0.0), 0.0)
            width = max(float(template.get("width") or 0.0), 0.0)
            y_offset = max(float(template.get("yOffset") or 0.0), 0.0)
        except Exception:
            x_offset = 0.0
            width = 0.0
            y_offset = 0.0
        line_bbox = line.get("bbox") or []
        if len(line_bbox) == 4:
            try:
                line_x0 = float(line_bbox[0])
                line_x1 = float(line_bbox[2])
                line_y0 = float(line_bbox[1])
                if width <= 0.0:
                    width = max(line_x1 - line_x0, 0.0)
                if x_offset <= 0.0:
                    x_offset = max(line_x0 - base_x0, 0.0)
                if y_offset <= 0.0:
                    y_offset = max(line_y0 - base_y0, 0.0)
            except Exception:
                pass
        else:
            y_offset = max(y_offset, 0.0)
        if width <= 0.0:
            continue
        normalized_templates.append({"xOffset": x_offset, "width": width, "yOffset": y_offset})
    return normalized_templates


def resolve_block_line_bounds(
    rect,
    block: Optional[Dict[str, Any]],
    line_index: int,
) -> Dict[str, float]:
    inner_left = float(rect.x0) + 1.0
    inner_right = float(rect.x1) - 1.0
    if inner_right <= inner_left:
        inner_right = inner_left + 1.0

    templates = normalize_wrap_line_templates(block)
    if not templates:
        return {
            "leftX": inner_left,
            "rightX": inner_right,
            "width": max(inner_right - inner_left, 1.0),
        }

    template = templates[min(max(line_index, 0), len(templates) - 1)]
    left_x = inner_left + float(template["xOffset"])
    right_x = min(left_x + max(float(template["width"]) - 1.0, 1.0), inner_right)
    if right_x <= left_x:
        return {
            "leftX": inner_left,
            "rightX": inner_right,
            "width": max(inner_right - inner_left, 1.0),
        }
    return {
        "leftX": left_x,
        "rightX": right_x,
        "width": max(right_x - left_x, 1.0),
    }


def resolve_block_line_top(
    rect,
    block: Optional[Dict[str, Any]],
    line_index: int,
    fontsize: float,
    lineheight: float,
) -> float:
    templates = normalize_wrap_line_templates(block)
    if templates:
        clamped_index = min(max(line_index, 0), len(templates) - 1)
        template = templates[clamped_index]
        if "yOffset" in template:
            base_top = float(rect.y0) + float(template.get("yOffset") or 0.0)
            if line_index <= len(templates) - 1:
                return base_top

            y_offsets = [
                float(item.get("yOffset") or 0.0)
                for item in templates
                if "yOffset" in item
            ]
            positive_steps = [
                y_offsets[idx] - y_offsets[idx - 1]
                for idx in range(1, len(y_offsets))
                if y_offsets[idx] - y_offsets[idx - 1] > 0.5
            ]
            fallback_step = (
                statistics.median(positive_steps)
                if positive_steps
                else fontsize * lineheight
            )
            extra_lines = line_index - (len(templates) - 1)
            return base_top + extra_lines * float(fallback_step)
    return float(rect.y0) + line_index * fontsize * lineheight


def adjust_line_bounds_for_drop_cap(
    bounds: Dict[str, float],
    block: Optional[Dict[str, Any]],
    line_top: float,
    line_bottom: float,
    *,
    padding: float = 4.0,
) -> Dict[str, float]:
    if not isinstance(block, dict):
        return bounds
    drop_cap = block.get("dropCap")
    if not isinstance(drop_cap, dict):
        return bounds
    bbox = drop_cap.get("bbox") or []
    if len(bbox) != 4:
        return bounds

    try:
        drop_x1 = float(bbox[2])
        drop_y0 = float(bbox[1])
        drop_y1 = float(bbox[3])
    except Exception:
        return bounds

    if line_bottom <= drop_y0 or line_top >= drop_y1:
        return bounds

    left_x = max(float(bounds["leftX"]), drop_x1 + padding)
    right_x = max(float(bounds["rightX"]), left_x + 1.0)
    return {
        "leftX": left_x,
        "rightX": right_x,
        "width": max(right_x - left_x, 1.0),
    }


def wrap_body_text_to_line_templates(
    text: str,
    rect,
    fontsize: float,
    measure_font,
    block: Dict[str, Any],
    lineheight: float = 1.1,
) -> List[Dict[str, Any]]:
    normalized_templates = normalize_wrap_line_templates(block)
    if not normalized_templates:
        return []

    normalized = normalize_text(text)
    if not normalized:
        return []

    def wrap_single_segment(segment_text: str) -> List[Dict[str, Any]]:
        normalized_segment = normalize_text(segment_text)
        if not normalized_segment:
            return []

        tokens = tokenize_plain_text(normalized_segment)
        line_specs: List[Dict[str, Any]] = []
        current_tokens: List[str] = []
        current_width = 0.0
        line_index = 0

        def current_bounds(index: int) -> Dict[str, float]:
            bounds = resolve_block_line_bounds(rect, {"wrapLineTemplates": normalized_templates}, index)
            line_top = resolve_block_line_top(rect, {"wrapLineTemplates": normalized_templates}, index, fontsize, lineheight)
            line_bottom = line_top + fontsize * lineheight
            return adjust_line_bounds_for_drop_cap(bounds, block, line_top, line_bottom)

        def flush_current() -> None:
            nonlocal current_tokens, current_width, line_index
            line_text = "".join(current_tokens).strip()
            if line_text:
                bounds = current_bounds(line_index)
                line_specs.append(
                    {
                        "text": line_text,
                        "leftX": float(bounds["leftX"]),
                        "rightX": float(bounds["rightX"]),
                        "maxWidth": max(float(bounds["width"]), fontsize),
                        "lineTop": float(resolve_block_line_top(rect, {"wrapLineTemplates": normalized_templates}, line_index, fontsize, lineheight)),
                    }
                )
                line_index += 1
            current_tokens = []
            current_width = 0.0

        for token in tokens:
            token_text = token if current_tokens else token.lstrip()
            if not token_text:
                continue

            bounds = current_bounds(line_index)
            max_width = max(float(bounds["width"]), fontsize)
            token_width = measure_text_width(measure_font, token_text, fontsize)
            next_width = current_width + token_width
            if current_tokens and next_width > max_width:
                overflow = next_width - max_width
                if is_footnote_marker_token(token_text) and overflow <= max(fontsize * 0.5, 1.5):
                    current_tokens.append(token_text)
                    current_width = next_width
                    continue
                if is_hanging_punctuation_token(token_text):
                    current_tokens.append(token_text)
                    current_width = next_width
                    continue
                flush_current()
                token_text = token.lstrip()
                if not token_text:
                    continue
                bounds = current_bounds(line_index)
                max_width = max(float(bounds["width"]), fontsize)
                token_width = measure_text_width(measure_font, token_text, fontsize)
                if current_tokens and current_width + token_width > max_width:
                    flush_current()

            current_tokens.append(token_text)
            current_width += token_width

        flush_current()
        return line_specs

    if block and footnote_markers_are_separate_source_lines(block):
        segments = split_metadata_marker_segments(normalized, block)
        if len(segments) > 1:
            merged_specs: List[Dict[str, Any]] = []
            for segment in segments:
                if not segment.strip():
                    continue
                merged_specs.extend(wrap_single_segment(segment))
            return merged_specs

    return wrap_single_segment(normalized)


def wrap_body_text_to_bbox(
    text: str,
    rect,
    fontsize: float,
    measure_font,
    block: Optional[Dict[str, Any]] = None,
) -> str:
    def wrap_single_segment(segment_text: str) -> str:
        normalized_segment = normalize_text(segment_text)
        if not normalized_segment:
            return ""

        max_width = max(rect.width - 1.0, fontsize)
        hanging_tolerance = max(fontsize * 1.15, 4.0)
        marker_tolerance = max(fontsize * 0.5, 1.5)
        tokens = tokenize_plain_text(normalized_segment)
        lines: List[str] = []
        current_tokens: List[str] = []
        current_width = 0.0

        def flush_current() -> None:
            nonlocal current_tokens, current_width
            line = "".join(current_tokens).strip()
            if line:
                lines.append(line)
            current_tokens = []
            current_width = 0.0

        for token in tokens:
            token_text = token if current_tokens else token.lstrip()
            if not token_text:
                continue

            token_width = measure_text_width(measure_font, token_text, fontsize)
            next_width = current_width + token_width
            if current_tokens and next_width > max_width:
                overflow = next_width - max_width
                if is_footnote_marker_token(token_text) and overflow <= marker_tolerance:
                    current_tokens.append(token_text)
                    current_width = next_width
                    continue
                if is_hanging_punctuation_token(token_text):
                    current_tokens.append(token_text)
                    current_width = next_width
                    continue
                flush_current()
                token_text = token.lstrip()
                if not token_text:
                    continue
                token_width = measure_text_width(measure_font, token_text, fontsize)

            current_tokens.append(token_text)
            current_width += token_width

        flush_current()
        return "\n".join(lines)

    normalized = normalize_text(text)
    if not normalized:
        return ""

    if block and footnote_markers_are_separate_source_lines(block):
        segments = split_metadata_marker_segments(normalized, block)
        if len(segments) > 1:
            wrapped_segments = [wrap_single_segment(segment) for segment in segments if segment.strip()]
            return "\n".join(segment for segment in wrapped_segments if segment.strip())

    return wrap_single_segment(normalized)


def build_line_specs_from_logical_lines(
    logical_lines: List[str],
    rect,
    fontsize: float,
    lineheight: float,
    block: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    line_specs: List[Dict[str, Any]] = []
    for line_index, line_text in enumerate(logical_lines):
        normalized_line = normalize_text(line_text)
        if not normalized_line:
            continue
        bounds = resolve_block_line_bounds(rect, block, line_index)
        line_top = resolve_block_line_top(rect, block, line_index, fontsize, lineheight)
        line_bottom = line_top + fontsize * lineheight
        bounds = adjust_line_bounds_for_drop_cap(bounds, block, line_top, line_bottom)
        line_specs.append(
            {
                "text": normalized_line,
                "leftX": float(bounds["leftX"]),
                "rightX": float(bounds["rightX"]),
                "maxWidth": max(float(bounds["width"]), fontsize),
                "lineTop": float(line_top),
            }
        )
    return line_specs


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
    merged_layout_lines = []
    for line in layout_lines:
        line_bbox = [float(v) for v in line.get("bbox", [0, 0, 0, 0])]
        line_text = normalize_text("".join(str(item.get("text", "") or "") for item in line.get("items", [])))
        if not line_text:
            continue
        if merged_layout_lines:
            previous = merged_layout_lines[-1]
            prev_bbox = previous["bbox"]
            same_row = (
                abs(float(line_bbox[1]) - float(prev_bbox[1])) <= 1.0
                and abs(float(line_bbox[3]) - float(prev_bbox[3])) <= 1.0
            )
            horizontal_gap = float(line_bbox[0]) - float(prev_bbox[2])
            if same_row and horizontal_gap >= -1.0 and horizontal_gap <= 36.0:
                previous["text"] = f"{previous['text']} {line_text}".strip()
                previous["bbox"] = expand_bbox(prev_bbox, line_bbox)
                continue
        merged_layout_lines.append({"text": line_text, "bbox": line_bbox})

    source_lines = [
        normalize_text(str(line.get("text", "") or ""))
        for line in merged_layout_lines
        if normalize_text(str(line.get("text", "") or ""))
    ]

    if len(source_lines) <= 1:
        return normalized

    if (
        block.get("blockType") in ("metadata", "footnote")
        and block.get("layoutIntent") != "note_paragraph"
        and rect is not None
        and fontsize is not None
        and measure_font is not None
    ):
        author_wrapped = wrap_author_metadata_by_source_roles(normalized, block)
        if author_wrapped:
            return author_wrapped
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

    if footnote_markers_are_separate_source_lines(block):
        segments = split_metadata_marker_segments(normalized, block)
        if len(segments) > 1:
            return "\n".join(segment for segment in segments if segment.strip())

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
    if should_use_body_bbox_wrap(block, font_role):
        return False
    if block.get("layoutIntent") == "note_paragraph" and not is_footnote_block(block):
        return False
    if block.get("blockType") in ("heading", "caption", "metadata", "footnote", "code", "other") and not is_footnote_block(block):
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
    if (
        block.get("hasBoldLike")
        or block.get("hasItalicLike")
        or block.get("hasMonospaceLike")
        or block.get("hasSuperscriptLike")
    ):
        return True
    return False


def should_apply_source_line_styles(block: Dict[str, Any]) -> bool:
    return bool(
        block.get("hasMonospaceLike")
        or block.get("hasBoldLike")
        or block.get("hasItalicLike")
        or block.get("hasSuperscriptLike")
    )


def placeholder_sort_key(value: str) -> int:
    match = re.search(r"(\d+)", value or "")
    return int(match.group(1)) if match else 0


def ordered_placeholder_keys(placeholders: Dict[str, Any]) -> List[str]:
    return sorted(placeholders.keys(), key=placeholder_sort_key)


def normalize_font_cache_key(font_options: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    return (
        str(font_options.get("fontfile")) if font_options.get("fontfile") else None,
        str(font_options.get("fontname")) if font_options.get("fontname") else None,
    )


def create_measure_font(fitz, font_options: Dict[str, Any]):
    cache_key = normalize_font_cache_key(font_options)
    cached = MEASURE_FONT_CACHE.get(cache_key)
    if cached is not None:
        return cached

    fontfile = font_options.get("fontfile")
    fontname = font_options.get("fontname")
    if fontfile:
        try:
            font = fitz.Font(fontfile=fontfile)
            try:
                setattr(font, "_wasabi_cache_key", cache_key)
            except Exception:
                pass
            MEASURE_FONT_CACHE[cache_key] = font
            return font
        except Exception:
            pass
    if fontname:
        try:
            font = fitz.Font(fontname=fontname)
            try:
                setattr(font, "_wasabi_cache_key", cache_key)
            except Exception:
                pass
            MEASURE_FONT_CACHE[cache_key] = font
            return font
        except Exception:
            pass
    fallback_key = (None, "helv")
    cached_fallback = MEASURE_FONT_CACHE.get(fallback_key)
    if cached_fallback is not None:
        return cached_fallback
    font = fitz.Font(fontname="helv")
    try:
        setattr(font, "_wasabi_cache_key", fallback_key)
    except Exception:
        pass
    MEASURE_FONT_CACHE[fallback_key] = font
    return font


def measure_text_width(measure_font, text: str, font_size: float) -> float:
    if not text:
        return 0.0
    cache_key = getattr(measure_font, "_wasabi_cache_key", None)
    width_key = None
    if cache_key is not None:
        width_key = (cache_key, float(font_size), text)
        cached = TEXT_WIDTH_CACHE.get(width_key)
        if cached is not None:
            return cached
    try:
        width = float(measure_font.text_length(text, fontsize=font_size))
    except Exception:
        width = estimate_text_units(text) * font_size * 0.62
    if width_key is not None:
        if len(TEXT_WIDTH_CACHE) >= TEXT_WIDTH_CACHE_MAX_ENTRIES:
            TEXT_WIDTH_CACHE.clear()
        TEXT_WIDTH_CACHE[width_key] = width
    return width


def line_style_font_options(
    block: Dict[str, Any],
    line_index: int,
    font_role: str,
    bold: bool,
    fallback_text: str,
) -> Dict[str, Any]:
    if should_apply_source_line_styles(block):
        style = get_source_line_style(block, line_index, font_role, bold)
        return resolve_font_options(
            fallback_text,
            bold=bool(style["bold"]),
            font_role=str(style["font_role"]),
            preferred_style=str(style["preferred_style"]),
            family_class=str(style.get("family_class") or block_style_family_class(block, font_role)),
        )
    return resolve_font_options(
        fallback_text,
        bold=bold,
        font_role=font_role,
        preferred_style=get_preferred_text_style(block, font_role, bold),
        family_class=block_style_family_class(block, font_role),
    )


def source_item_style_runs(
    block: Dict[str, Any],
    line_index: int,
    default_font_role: str,
    default_bold: bool,
) -> List[Dict[str, Any]]:
    layout_lines = block.get("layoutLines") or []
    if line_index < 0 or line_index >= len(layout_lines):
        return []

    runs: List[Dict[str, Any]] = []
    for item in layout_lines[line_index].get("items", []) or []:
        if item.get("type") != "text":
            continue
        item_text = str(item.get("text", "") or "")
        if not normalize_text(item_text):
            continue
        item_font_role = default_font_role
        item_bold = default_bold
        item_preferred = get_preferred_text_style(block, default_font_role, default_bold)
        if bool(item.get("isMonospaceLike")):
            item_font_role = "code"
            item_bold = False
            item_preferred = "monospace"
        elif bool(item.get("isItalicLike")):
            item_bold = bool(item.get("isBoldLike") or default_bold)
            item_preferred = "bold_italic" if item_bold else "italic"
        elif bool(item.get("isBoldLike")):
            item_bold = True
            item_preferred = "bold"

        run = {
            "units": max(estimate_text_units(normalize_text(item_text)), 1.0),
            "font_role": item_font_role,
            "bold": item_bold,
            "preferred_style": item_preferred,
            "family_class": item_family_class(item, item_font_role),
        }
        if (
            runs
            and runs[-1]["font_role"] == run["font_role"]
            and runs[-1]["bold"] == run["bold"]
            and runs[-1]["preferred_style"] == run["preferred_style"]
            and runs[-1]["family_class"] == run["family_class"]
        ):
            runs[-1]["units"] += run["units"]
        else:
            runs.append(run)
    return runs


def classify_latin_font_family(font_name: str) -> str:
    normalized = str(font_name or "").lower()
    if any(token in normalized for token in ("cour", "mono", "consol", "menlo", "code")):
        return "cour"
    if any(token in normalized for token in ("helv", "arial", "sans", "gothic")):
        return "helv"
    if any(token in normalized for token in ("times", "rom", "serif", "garamond", "georgia", "nimbusrom")):
        return "times"
    return "times"


def classify_token_script(token_text: str) -> str:
    stripped = (token_text or "").strip()
    if not stripped:
        return "space"
    if requires_cjk_font(stripped):
        return "cjk"
    if re.search(r"[A-Za-z]", stripped):
        return "latin"
    if FORMULA_SYMBOL_REGEX.search(stripped) or re.search(r"[α-ωΑ-Ω]", stripped):
        return "math"
    if re.fullmatch(r"[\d.,;:!?%+\-=/<>()[\]{}]+", stripped):
        return "neutral"
    return "other"


def dominant_body_latin_family(block: Dict[str, Any]) -> str:
    cached = block.get("_bodyLatinFamily")
    if isinstance(cached, str) and cached:
        return cached

    families: Dict[str, int] = {}
    for line in block.get("layoutLines") or []:
        for item in line.get("items", []) or []:
            if item.get("type") != "text":
                continue
            item_text = str(item.get("text", "") or "")
            if not re.search(r"[A-Za-z]", item_text):
                continue
            family = classify_latin_font_family(str(item.get("font", "") or ""))
            families[family] = families.get(family, 0) + max(len(re.findall(r"[A-Za-z]+", item_text)), 1)

    dominant = max(families.items(), key=lambda item: item[1])[0] if families else "times"
    block["_bodyLatinFamily"] = dominant
    return dominant


def dominant_page_body_latin_family(page_blocks: List[Dict[str, Any]]) -> str:
    families: Dict[str, int] = {}
    for block in page_blocks:
        if str(block.get("blockType") or "") != "body":
            continue
        for line in block.get("layoutLines") or []:
            for item in line.get("items", []) or []:
                if item.get("type") != "text":
                    continue
                item_text = str(item.get("text", "") or "")
                if not re.search(r"[A-Za-z]", item_text):
                    continue
                family = classify_latin_font_family(str(item.get("font", "") or ""))
                families[family] = families.get(family, 0) + max(len(re.findall(r"[A-Za-z]+", item_text)), 1)
    return max(families.items(), key=lambda item: item[1])[0] if families else "times"


def resolve_latin_font_by_family(
    family: str,
    *,
    bold: bool = False,
    preferred_style: str = "normal",
) -> Dict[str, Any]:
    normalized_family = str(family or "times").lower()
    if normalized_family == "cour":
        return {"fontname": "cour"}
    if normalized_family == "helv":
        if preferred_style == "bold":
            return {"fontname": "helvB"}
        return {"fontname": "helvB" if bold else "helv"}

    if preferred_style == "monospace":
        return {"fontname": "cour"}
    if preferred_style == "bold_italic":
        return {"fontname": "Times-BoldItalic"}
    if preferred_style == "italic":
        return {"fontname": "Times-Italic"}
    if preferred_style == "bold":
        return {"fontname": "Times-Bold"}
    return {"fontname": "Times-Bold" if bold else "Times-Roman"}


def extract_body_style_term_hints(block: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    cached = block.get("_bodyStyleTermHints")
    if isinstance(cached, dict):
        return cached

    hints: Dict[str, Dict[str, Any]] = {}
    for line in block.get("layoutLines") or []:
        for item in line.get("items", []) or []:
            if item.get("type") != "text":
                continue
            item_text = str(item.get("text", "") or "")
            if not normalize_text(item_text):
                continue
            for token in tokenize_plain_text(item_text):
                stripped = token.strip()
                if not stripped or requires_cjk_font(stripped):
                    continue
                if not re.search(r"[A-Za-z]", stripped):
                    continue
                if len(stripped) > 40:
                    continue
                key = stripped.lower()
                font_role = "code" if bool(item.get("isMonospaceLike")) else "body"
                bold = bool(item.get("isBoldLike"))
                if bool(item.get("isMonospaceLike")):
                    preferred_style = "monospace"
                elif bool(item.get("isItalicLike")):
                    preferred_style = "bold_italic" if bold else "italic"
                elif bold:
                    preferred_style = "bold"
                else:
                    preferred_style = "normal"

                existing = hints.get(key)
                priority = (
                    4 if preferred_style == "monospace"
                    else 3 if preferred_style == "bold_italic"
                    else 2 if preferred_style == "italic"
                    else 1 if preferred_style == "bold"
                    else 0
                )
                if existing is None or priority > int(existing.get("priority", -1)):
                    hints[key] = {
                        "font_role": font_role,
                        "bold": bold,
                        "preferred_style": preferred_style,
                        "latin_family": classify_latin_font_family(str(item.get("font", "") or "")),
                        "family_class": item_family_class(item, font_role),
                        "priority": priority,
                    }

    block["_bodyStyleTermHints"] = hints
    return hints


def body_token_font_options(
    token_text: str,
    block: Dict[str, Any],
    base_font_options: Dict[str, Any],
    font_role: str,
    bold: bool,
    preferred_style: str,
) -> Dict[str, Any]:
    stripped = token_text.strip()
    script = classify_token_script(stripped)
    if script == "space":
        return base_font_options
    if script == "cjk":
        return resolve_font_options(
            stripped or token_text,
            bold=bold,
            font_role=font_role,
            preferred_style=preferred_style,
            family_class=block_style_family_class(block, font_role),
        )

    default_latin_family = str(
        block.get("pageBodyLatinFamily")
        or block.get("_bodyLatinFamily")
        or dominant_body_latin_family(block)
    )

    hint = extract_body_style_term_hints(block).get(stripped.lower())
    if hint is not None:
        return resolve_latin_font_by_family(
            str(hint.get("latin_family") or default_latin_family),
            bold=bool(hint.get("bold")),
            preferred_style=str(hint.get("preferred_style") or preferred_style),
        )

    if script == "math":
        return resolve_latin_font_by_family(
            default_latin_family,
            bold=False,
            preferred_style="italic",
        )

    return resolve_latin_font_by_family(
        default_latin_family,
        bold=bold,
        preferred_style=preferred_style,
    )


def styled_text_tokens(
    text: str,
    block: Optional[Dict[str, Any]],
    line_index: int,
    base_font_options: Dict[str, Any],
    font_role: str,
    bold: bool,
    preferred_style: str,
) -> List[Dict[str, Any]]:
    tokens = [token for token in tokenize_plain_text(text) if token]
    if not tokens:
        return []

    if block is None:
        return [
            {
                "text": token,
                "font_role": font_role,
                "bold": bold,
                "preferred_style": preferred_style,
                "font_options": text_token_font_options(
                    token,
                    base_font_options,
                    font_role,
                    bold,
                    preferred_style,
                    block_style_family_class(block, font_role) if block is not None else "serif",
                ),
            }
            for token in tokens
        ]

    if should_use_body_bbox_wrap(block, font_role):
        scripts = [classify_token_script(token.strip()) for token in tokens]
        contextual_scripts = list(scripts)
        for index, script in enumerate(scripts):
            if script != "neutral":
                continue
            prev_script = next(
                (scripts[pos] for pos in range(index - 1, -1, -1) if scripts[pos] not in ("space", "neutral")),
                None,
            )
            next_script = next(
                (scripts[pos] for pos in range(index + 1, len(scripts)) if scripts[pos] not in ("space", "neutral")),
                None,
            )
            contextual_scripts[index] = (
                prev_script
                if prev_script == next_script and prev_script is not None
                else prev_script or next_script or "cjk"
            )

        styled_body_tokens = []
        for token, contextual_script in zip(tokens, contextual_scripts):
            token_font_options = (
                base_font_options
                if contextual_script == "cjk"
                else body_token_font_options(
                    token,
                    block,
                    base_font_options,
                    font_role,
                    bold,
                    preferred_style,
                )
            )
            styled_body_tokens.append(
                {
                    "text": token,
                    "font_role": font_role,
                    "bold": bold,
                    "preferred_style": preferred_style,
                    "font_options": token_font_options,
                }
            )
        return styled_body_tokens

    runs = source_item_style_runs(block, line_index, font_role, bold)
    if not runs:
        return [
            {
                "text": token,
                "font_role": font_role,
                "bold": bold,
                "preferred_style": preferred_style,
                "font_options": text_token_font_options(
                    token,
                    base_font_options,
                    font_role,
                    bold,
                    preferred_style,
                    block_style_family_class(block, font_role),
                ),
            }
            for token in tokens
        ]

    total_units = sum(float(run["units"]) for run in runs) or 1.0
    run_index = 0
    consumed_units = 0.0
    run_limit = float(runs[0]["units"])
    styled: List[Dict[str, Any]] = []

    for token in tokens:
        stripped = token.strip()
        token_units = estimate_text_units(stripped) if stripped else 0.0
        while run_index < len(runs) - 1 and consumed_units >= run_limit - 1e-6:
            run_index += 1
            run_limit += float(runs[run_index]["units"])
        run = runs[run_index]
        token_font_options = resolve_font_options(
            stripped or token,
            bold=bool(run["bold"]),
            font_role=str(run["font_role"]),
            preferred_style=str(run["preferred_style"]),
            family_class=str(run.get("family_class") or "serif"),
        )
        token_font_options = text_token_font_options(
            token,
            token_font_options,
            str(run["font_role"]),
            bool(run["bold"]),
            str(run["preferred_style"]),
            str(run.get("family_class") or "serif"),
        )
        styled.append({"text": token, "font_options": token_font_options})
        styled[-1]["font_role"] = str(run["font_role"])
        styled[-1]["bold"] = bool(run["bold"])
        styled[-1]["preferred_style"] = str(run["preferred_style"])
        if token_units > 0:
            consumed_units += token_units
            consumed_units = min(consumed_units, total_units)

    return styled


def text_token_font_options(
    token_text: str,
    base_font_options: Dict[str, Any],
    font_role: str,
    bold: bool,
    preferred_style: str,
    family_class: str,
) -> Dict[str, Any]:
    stripped = token_text.strip()
    if not stripped:
        return base_font_options
    if requires_cjk_font(stripped):
        return resolve_font_options(
            stripped,
            bold=bold,
            font_role=font_role,
            preferred_style=preferred_style,
            family_class=family_class,
        )
    return resolve_font_options(
        stripped,
        bold=bold,
        font_role=font_role,
        preferred_style=preferred_style,
        family_class=family_class,
    )


def measure_script_split_line_width(
    fitz,
    text: str,
    font_size: float,
    base_font_options: Dict[str, Any],
    font_role: str,
    bold: bool,
    preferred_style: str,
    block: Optional[Dict[str, Any]] = None,
    line_index: int = -1,
) -> float:
    total = 0.0
    for token_info in styled_text_tokens(
        text,
        block,
        line_index,
        base_font_options,
        font_role,
        bold,
        preferred_style,
    ):
        token_measure_font = create_measure_font(fitz, token_info["font_options"])
        total += measure_text_width(token_measure_font, str(token_info["text"]), font_size)
    return total


def insert_script_split_line(
    page_or_shape,
    fitz,
    origin,
    text: str,
    font_size: float,
    base_font_options: Dict[str, Any],
    font_role: str,
    bold: bool,
    preferred_style: str,
    color=(0, 0, 0),
    block: Optional[Dict[str, Any]] = None,
    line_index: int = -1,
) -> float:
    current_x = float(origin[0])
    baseline_y = float(origin[1])
    for token_info in styled_text_tokens(
        text,
        block,
        line_index,
        base_font_options,
        font_role,
        bold,
        preferred_style,
    ):
        token = str(token_info["text"])
        token_font_role = str(token_info.get("font_role") or font_role)
        token_bold = bool(token_info.get("bold", bold))
        token_preferred_style = str(token_info.get("preferred_style") or preferred_style)
        token_font_options = token_info["font_options"]
        token_draw_options = dict(token_font_options)
        token_draw_options.pop("color", None)
        token_measure_font = create_measure_font(fitz, token_font_options)
        page_or_shape.insert_text(
            (current_x, baseline_y),
            token,
            fontsize=font_size,
            color=color,
            **token_draw_options,
        )
        if (
            requires_cjk_font(token)
            and token_draw_options.get("fontfile")
            and token_draw_options.get("fontname") == "cjk_fallback"
            and token_preferred_style in {"bold", "bold_italic"}
        ):
            page_or_shape.insert_text(
                (current_x + max(font_size * 0.018, 0.18), baseline_y),
                token,
                fontsize=font_size,
                color=color,
                **token_draw_options,
            )
        current_x += measure_text_width(token_measure_font, token, font_size)
    return current_x - float(origin[0])


def render_simple_wrapped_lines(
    page,
    fitz,
    rect,
    logical_lines: List[str],
    font_size: float,
    block: Dict[str, Any],
    font_role: str,
    bold: bool,
    preferred_style: str,
    lineheight: float,
    font_options: Dict[str, Any],
    color=(0, 0, 0),
) -> bool:
    measure_font = create_measure_font(fitz, font_options)
    max_line_width = 0.0
    for line_text in logical_lines:
        max_line_width = max(
            max_line_width,
            measure_script_split_line_width(
                fitz,
                line_text,
                font_size,
                font_options,
                font_role,
                bold,
                preferred_style,
                block=block,
                line_index=-1,
            ),
        )
    total_height = len(logical_lines) * font_size * lineheight
    if max_line_width > rect.width - 2 or total_height > rect.height + 1:
        return False

    ascender = float(getattr(measure_font, "ascender", 1.0) or 1.0)
    for line_index, line_text in enumerate(logical_lines):
        baseline_y = rect.y0 + line_index * font_size * lineheight + font_size * ascender
        insert_script_split_line(
            page,
            fitz,
            (rect.x0 + 1.0, baseline_y),
            line_text,
            font_size,
            font_options,
            font_role,
            bold,
            preferred_style,
            color=color,
            block=block,
            line_index=-1,
        )
    return True


def render_body_wrapped_lines(
    page,
    fitz,
    rect,
    lines: List[str],
    font_size: float,
    block: Dict[str, Any],
    font_role: str,
    bold: bool,
    preferred_style: str,
    lineheight: float,
    color=(0, 0, 0),
    source_doc=None,
) -> bool:
    line_specs = build_line_specs_from_logical_lines(
        lines,
        rect,
        font_size,
        lineheight,
        block,
    )
    return render_text_line_specs(
        page,
        fitz,
        rect,
        line_specs,
        font_size,
        block,
        font_role,
        bold,
        preferred_style,
        color=color,
        source_doc=source_doc,
    )


def render_body_wrapped_line_specs(
    page,
    fitz,
    rect,
    line_specs: List[Dict[str, Any]],
    font_size: float,
    block: Dict[str, Any],
    font_role: str,
    bold: bool,
    preferred_style: str,
    lineheight: float,
    color=(0, 0, 0),
    source_doc=None,
) -> bool:
    return render_text_line_specs(
        page,
        fitz,
        rect,
        line_specs,
        font_size,
        block,
        font_role,
        bold,
        preferred_style,
        color=color,
        source_doc=source_doc,
    )


def render_text_line_specs(
    page,
    fitz,
    rect,
    line_specs: List[Dict[str, Any]],
    font_size: float,
    block: Dict[str, Any],
    font_role: str,
    bold: bool,
    preferred_style: str,
    color=(0, 0, 0),
    source_doc=None,
) -> bool:
    family_class = block_style_family_class(block, font_role)
    base_font_options = resolve_font_options(
        "测",
        bold=bold,
        font_role=font_role,
        preferred_style=preferred_style,
        family_class=family_class,
    )
    if not line_specs:
        return False

    token_lines: List[List[Dict[str, Any]]] = []
    max_squeeze = max(font_size * 0.12, 0.8)
    clip_queues = preservable_formula_placeholder_queues(block) if source_doc is not None else {}
    block_font_size = float(block.get("fontSize") or font_size or 10.0)

    for line_spec in line_specs:
        line = str(line_spec.get("text") or "")
        max_width = float(line_spec.get("maxWidth") or 0.0)
        if max_width <= 0:
            return False
        token_infos = styled_text_tokens(
            line,
            block,
            -1,
            base_font_options,
            font_role,
            bold,
            preferred_style,
        )
        if not token_infos:
            token_lines.append([])
            continue

        widths = []
        formula_metadata_by_index: Dict[int, Dict[str, Any]] = {}
        for index, token_info in enumerate(token_infos):
            token_text = str(token_info["text"])
            metadata = None
            if source_doc is not None:
                queue = clip_queues.get(token_text.strip()) or []
                if queue:
                    metadata = queue.pop(0)
                    formula_metadata_by_index[index] = metadata
            if metadata is not None:
                widths.append(
                    estimate_formula_placeholder_width(
                        metadata,
                        font_size,
                        block_font_size,
                    )
                )
            else:
                widths.append(
                    measure_text_width(
                        create_measure_font(fitz, token_info["font_options"]),
                        token_text,
                        font_size,
                    )
                )

        natural_width = sum(widths)
        overflow = natural_width - max_width
        gaps = max(len(token_infos) - 1, 0)
        if overflow > 0:
            if gaps <= 0:
                return False
            squeeze_per_gap = overflow / gaps
            if squeeze_per_gap > max_squeeze:
                return False
            gap_adjustments = [squeeze_per_gap] * gaps
        else:
            gap_adjustments = [0.0] * gaps

        materialized: List[Dict[str, Any]] = []
        for index, token_info in enumerate(token_infos):
            materialized.append(
                {
                    "text": str(token_info["text"]),
                    "font_options": token_info["font_options"],
                    "width": widths[index],
                    "gap_after": gap_adjustments[index] if index < len(gap_adjustments) else 0.0,
                    "formula_metadata": formula_metadata_by_index.get(index),
                }
            )
        token_lines.append(materialized)

    if not line_specs:
        return False

    first_top = float(line_specs[0].get("lineTop") or 0.0)
    last_top = float(line_specs[-1].get("lineTop") or first_top)
    estimated_lineheight = 1.1
    if len(line_specs) >= 2:
        positive_steps = [
            float(line_specs[idx].get("lineTop") or 0.0) - float(line_specs[idx - 1].get("lineTop") or 0.0)
            for idx in range(1, len(line_specs))
        ]
        positive_steps = [step for step in positive_steps if step > 0.5]
        if positive_steps:
            estimated_lineheight = statistics.median(positive_steps) / max(font_size, 1.0)
    total_height = (last_top - first_top) + font_size * estimated_lineheight
    if total_height > rect.height + 1:
        return False

    ascender_font = create_measure_font(fitz, base_font_options)
    ascender_default = float(getattr(ascender_font, "ascender", 1.0) or 1.0)
    source_page_number = max(int(block.get("page", 1)) - 1, 0)
    shape = page.new_shape()
    formula_draw_ops: List[Tuple[Any, int, Any]] = []
    for line_index, token_infos in enumerate(token_lines):
        line_top = float(line_specs[line_index].get("lineTop") or resolve_block_line_top(rect, block, line_index, font_size, estimated_lineheight))
        baseline_y = line_top + font_size * ascender_default
        line_left_x = float(line_specs[line_index].get("leftX") or (rect.x0 + 1.0))
        current_x = line_left_x
        for token_info in token_infos:
            metadata = token_info.get("formula_metadata")
            if source_doc is not None and isinstance(metadata, dict):
                bbox = metadata.get("bbox") or [0, 0, 0, 0]
                line_bbox = metadata.get("lineBBox") or bbox
                if len(bbox) == 4 and len(line_bbox) == 4:
                    rect_type = page.rect.__class__
                    source_page = source_doc[source_page_number]
                    clip = source_page.rect & rect_type(*bbox)
                    scale = font_size / max(block_font_size or 10.0, 1.0)
                    dest_rect = rect_type(
                        current_x,
                        line_top + (float(bbox[1]) - float(line_bbox[1])) * scale,
                        current_x + (float(bbox[2]) - float(bbox[0])) * scale,
                        line_top + (float(bbox[3]) - float(line_bbox[1])) * scale,
                    )
                    if not clip.is_empty and not dest_rect.is_empty:
                        formula_draw_ops.append((dest_rect, source_page_number, clip))
                        current_x += float(token_info["width"]) - float(token_info["gap_after"])
                        continue
            draw_options = dict(token_info["font_options"])
            draw_options.pop("color", None)
            shape.insert_text(
                (current_x, baseline_y),
                token_info["text"],
                fontsize=font_size,
                color=color,
                **draw_options,
            )
            current_x += float(token_info["width"]) - float(token_info["gap_after"])
    shape.commit(overlay=True)
    for dest_rect, source_page_number, clip in formula_draw_ops:
        page.show_pdf_page(
            dest_rect,
            source_doc,
            source_page_number,
            clip=clip,
            overlay=True,
        )
    return True
def estimate_formula_placeholder_width(metadata: Dict[str, Any], font_size: float, block_font_size: float) -> float:
    if not isinstance(metadata, dict):
        fallback_text = str(metadata or "")
        return estimate_text_units(fallback_text) * font_size * 0.62
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
            token_text = str(metadata.get("text", "") or "") if isinstance(metadata, dict) else str(metadata or "")
            tokens.append(
                {
                    "type": "formula",
                    "key": part,
                    "text": token_text,
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

    wrap_templates = normalize_wrap_line_templates(block)
    use_dynamic_line_bounds = bool(wrap_templates)

    if not preserve_source_breaks and not use_dynamic_line_bounds:
        max_widths_per_line = [max(rect.width - 4, font_size * 1.2)]

    lines: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    current_width = 0.0
    line_index = 0

    for token in tokens:
        token_width = float(token["width"])
        if use_dynamic_line_bounds:
            line_limit = max(float(resolve_block_line_bounds(rect, block, line_index)["width"]), font_size * 1.2)
        else:
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


def union_bboxes(boxes: List[List[float]]) -> Optional[List[float]]:
    if not boxes:
        return None
    x0 = min(float(box[0]) for box in boxes)
    y0 = min(float(box[1]) for box in boxes)
    x1 = max(float(box[2]) for box in boxes)
    y1 = max(float(box[3]) for box in boxes)
    return [x0, y0, x1, y1]


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
    if has_section_heading_signal(block):
        return False
    if block.get("doclingLabel") in ("caption", "section_header", "title"):
        return False
    if is_prose_like_block(text):
        return False

    sentence_punct_count = len(re.findall(r"[，。；：.!?]", text))
    latin_words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
    cjk_chunks = re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]{2,}", text)
    token_count = len(re.findall(r"\S+", text))
    rotation = abs(int(block.get("rotation") or 0))
    font_size = float(block.get("fontSize") or 0.0)
    page_body_font_size = float(block.get("pageBodyFontSize") or 0.0)
    docling_label = str(block.get("doclingLabel") or "")

    if block_width(block) >= max(float(block.get("pageWidth") or 0.0) * 0.42, 220.0):
        return False

    if re.search(r"<[^>]+>", text):
        return True
    if docling_label == "picture" and token_count <= 8 and sentence_punct_count == 0:
        return True
    if rotation and token_count <= 8 and sentence_punct_count == 0:
        return True
    if (
        page_body_font_size > 0
        and font_size > 0
        and font_size <= page_body_font_size - 1.2
        and token_count <= 8
        and sentence_punct_count == 0
    ):
        return True
    if len(text) <= 28 and sentence_punct_count == 0 and len(latin_words) + len(cjk_chunks) <= 8:
        return True
    if len(text) <= 28 and len(re.findall(r"\d", text)) >= 1 and sentence_punct_count == 0:
        return True
    return False

