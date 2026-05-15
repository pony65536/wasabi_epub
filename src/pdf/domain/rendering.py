from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Tuple

from domain.core import *


def fit_drop_cap_block(
    page,
    rect,
    text: str,
    block: Dict[str, Any],
    font_size: float,
    fitz,
    min_font_size: float = 5.0,
) -> bool:
    layout_lines = block.get("layoutLines") or []
    first_item = None
    for line in layout_lines:
        for item in line.get("items", []) or []:
            if item.get("type") == "text" and normalize_text(str(item.get("text", "") or "")):
                first_item = item
                break
        if first_item is not None:
            break
    if first_item is None:
        return False

    single_text = "".join(ch for ch in normalize_text(text) if not ch.isspace())[:1]
    if not single_text:
        return False

    style = source_item_visual_style(first_item, block, get_font_role(block))
    font_options = resolve_font_options(
        single_text,
        bold=bool(style["bold"]),
        font_role=str(style["font_role"]),
        preferred_style=str(style["preferred_style"]),
        family_class=str(style["family_class"]),
    )
    color = tuple(style["color"])
    measure_font = create_measure_font(fitz, font_options)
    anchor_top = float(block.get("dropCapAnchorTop") or rect.y0)
    left_x = float(rect.x0) + 1.0
    available_height = max(float(rect.y1) - anchor_top, 1.0)
    available_width = max(float(rect.x1) - left_x - 1.0, 1.0)
    size = max(min(font_size or style["font_size"] or 10.0, 72.0), min_font_size)

    glyph_top = None
    glyph_bottom = None
    try:
        glyph_box = measure_font.glyph_bbox(ord(single_text))
        glyph_top = float(glyph_box.y1)
        glyph_bottom = float(glyph_box.y0)
    except Exception:
        glyph_top = None
        glyph_bottom = None

    while size >= min_font_size:
        line_width = measure_script_split_line_width(
            fitz,
            single_text,
            size,
            font_options,
            str(style["font_role"]),
            bool(style["bold"]),
            str(style["preferred_style"]),
            block=block,
            line_index=0,
        )
        if glyph_top is not None and glyph_bottom is not None:
            line_height = size * max(glyph_top - glyph_bottom, 1.0)
            baseline_y = anchor_top + size * glyph_top
        else:
            ascender = float(getattr(measure_font, "ascender", 1.0) or 1.0)
            descender = abs(float(getattr(measure_font, "descender", -0.2) or -0.2))
            line_height = size * max(ascender + descender, 1.0)
            baseline_y = anchor_top + size * ascender
        if line_width <= available_width + 1.0 and line_height <= available_height + 1.0:
            insert_script_split_line(
                page,
                fitz,
                (left_x, baseline_y),
                single_text,
                size,
                font_options,
                str(style["font_role"]),
                bool(style["bold"]),
                str(style["preferred_style"]),
                color=color,
                block=block,
                line_index=0,
            )
            return True
        size -= 0.5
    return False


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
    source_doc=None,
) -> bool:
    # Start from the extracted size so the result stays visually closer to the source.
    size = max(min(font_size or 10, 36), min_font_size)
    preferred_style = get_preferred_text_style(block, font_role, bold)
    family_class = block_style_family_class(block, font_role)
    primary_color = block_primary_text_color(block)
    font_options = resolve_font_options(
        text,
        bold=bold,
        font_role=font_role,
        preferred_style=preferred_style,
        family_class=family_class,
    )
    measure_font = create_measure_font(fitz, font_options)
    preserve_source_breaks = should_preserve_source_line_breaks(block, font_role)
    layout_lines = block.get("layoutLines") or []

    # Very thin single-line blocks are more reliable with direct baseline text placement
    # than with insert_textbox, especially for CJK fonts near the rect height limit.
    if rotation == 0 and len(layout_lines) <= 1 and rect.height <= max((font_size or 10) * 1.15, 12):
        single_line = normalize_text(text)
        while size >= min_font_size:
            line_width = measure_script_split_line_width(
                fitz,
                single_line,
                size,
                font_options,
                font_role,
                bold,
                preferred_style,
                block=block,
                line_index=0,
            )
            ascender = float(getattr(measure_font, "ascender", 1.0) or 1.0)
            descender = abs(float(getattr(measure_font, "descender", -0.2) or -0.2))
            line_height = size * max(ascender + descender, 1.0)
            if line_width <= rect.width - 2 and line_height <= rect.height + 1:
                baseline_y = rect.y0 + size * ascender
                insert_script_split_line(
                    page,
                    fitz,
                    (rect.x0 + 1.0, baseline_y),
                    single_line,
                    size,
                    font_options,
                    font_role,
                    bold,
                    preferred_style,
                    block=block,
                    line_index=0,
                )
                return True
            size -= 0.5

    while size >= min_font_size:
        use_body_wrap = should_use_body_bbox_wrap(block, font_role)
        if use_body_wrap:
            irregular_line_specs = []
            if has_irregular_body_wrap_shape(block) or has_dynamic_body_line_bounds(block):
                irregular_line_specs = wrap_body_text_to_line_templates(
                    text,
                    rect,
                    size,
                    measure_font,
                    block,
                    lineheight=1.05 if bold else 1.1,
                )
            wrapped = (
                None
                if irregular_line_specs
                else wrap_body_text_to_bbox(text, rect, size, measure_font, block)
            )
        else:
            wrapped = (
                wrap_text_by_source_line_breaks(text, block, rect, size, measure_font)
                if preserve_source_breaks
                else wrap_text_for_box_precise(text, rect, size, measure_font)
            )
        if use_body_wrap:
            logical_lines = [line for line in (wrapped or "").splitlines() if line.strip()]
            lineheight = 1.05 if bold else 1.1
            if irregular_line_specs:
                if render_body_wrapped_line_specs(
                    page,
                    fitz,
                    rect,
                    irregular_line_specs,
                    size,
                    block,
                    font_role,
                    bold,
                    preferred_style,
                    lineheight,
                    color=primary_color,
                    source_doc=source_doc,
                ):
                    return True
                size -= 0.5
                continue
            elif logical_lines and render_body_wrapped_lines(
                page,
                fitz,
                rect,
                logical_lines,
                size,
                block,
                font_role,
                bold,
                preferred_style,
                lineheight,
                color=primary_color,
                source_doc=source_doc,
            ):
                return True
        if preserve_source_breaks and should_apply_source_line_styles(block):
            logical_lines = wrapped.splitlines()
            if logical_lines:
                max_line_width = 0.0
                for line_index, line_text in enumerate(logical_lines):
                    style = get_source_line_style(block, line_index, font_role, bold)
                    line_font_options = line_style_font_options(
                        block,
                        line_index,
                        font_role,
                        bold,
                        line_text,
                    )
                    line_measure_font = create_measure_font(fitz, line_font_options)
                    max_line_width = max(
                        max_line_width,
                        measure_script_split_line_width(
                            fitz,
                            line_text,
                            size,
                            line_font_options,
                            str(style["font_role"]),
                            bool(style["bold"]),
                            str(style["preferred_style"]),
                            block=block,
                            line_index=line_index,
                        ),
                    )
                lineheight = 1.05 if bold else 1.1
                total_height = len(logical_lines) * size * lineheight
                if max_line_width <= rect.width - 2 and total_height <= rect.height + 1:
                    ascender_default = float(getattr(measure_font, "ascender", 1.0) or 1.0)
                    for line_index, line_text in enumerate(logical_lines):
                        style = get_source_line_style(block, line_index, font_role, bold)
                        line_font_options = line_style_font_options(
                            block,
                            line_index,
                            font_role,
                            bold,
                            line_text,
                        )
                        line_measure_font = create_measure_font(fitz, line_font_options)
                        ascender = float(getattr(line_measure_font, "ascender", ascender_default) or ascender_default)
                        baseline_y = rect.y0 + line_index * size * lineheight + size * ascender
                        insert_script_split_line(
                            page,
                            fitz,
                            (rect.x0 + 1.0, baseline_y),
                            line_text,
                            size,
                            line_font_options,
                            str(style["font_role"]),
                            bool(style["bold"]),
                            str(style["preferred_style"]),
                            color=primary_color,
                            block=block,
                            line_index=line_index,
                        )
                    return True
        if requires_cjk_font(wrapped) and preferred_style in {"bold", "bold_italic"}:
            logical_lines = [line for line in wrapped.splitlines() if line.strip()]
            if logical_lines and render_simple_wrapped_lines(
                page,
                fitz,
                rect,
                logical_lines,
                size,
                block,
                font_role,
                bold,
                preferred_style,
                1.05 if bold else 1.1,
                font_options,
                color=primary_color,
            ):
                return True
        shape = page.new_shape()
        overflow = shape.insert_textbox(
            rect,
            wrapped,
            fontsize=size,
            color=primary_color,
            align=fitz.TEXT_ALIGN_LEFT,
            rotate=rotation,
            lineheight=1.05 if bold else 1.1,
            **font_options,
        )
        if overflow >= 0:
            shape.commit()
            return True
        # Shape not committed — no text written to page, safe to retry with smaller size.
        size -= 0.5

    fallback_size = max(min(min_font_size, font_size or 10), 3.0)
    try:
        wrapped = (
            wrap_text_by_source_line_breaks(text, block, rect, fallback_size, measure_font)
            if preserve_source_breaks
            else wrap_text_for_box_precise(text, rect, fallback_size, measure_font)
        )
        fallback_shape = page.new_shape()
        overflow = fallback_shape.insert_textbox(
            rect,
            wrapped,
            fontsize=fallback_size,
            color=primary_color,
            align=fitz.TEXT_ALIGN_LEFT,
            rotate=rotation,
            lineheight=1.0,
            **font_options,
        )
        if overflow >= 0:
            fallback_shape.commit()
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


def restore_non_preservable_inline_placeholders(
    text: str,
    block: Dict[str, Any],
    *,
    keep_preservable: bool,
) -> str:
    placeholders = block.get("inlineFormulaPlaceholders") or {}
    if not placeholders or "@@WASABI_INLINE_FORMULA_" not in (text or ""):
        return text

    def replacement(match: re.Match[str]) -> str:
        key = match.group(0)
        metadata = placeholders.get(key)
        if keep_preservable and isinstance(metadata, dict) and is_preservable_formula_metadata(block, metadata):
            return key
        if isinstance(metadata, dict):
            return str(metadata.get("text", "") or "")
        return str(metadata or "")

    return INLINE_FORMULA_PLACEHOLDER_REGEX.sub(replacement, text)


def normalize_author_metadata_text(text: str, block: Dict[str, Any]) -> str:
    if not text:
        return text
    if not (
        "@" in text
        or "Google" in text
        or "谷歌" in text
        or "University" in text
        or "大学" in text
        or "Research" in text
        or "Brain" in text
    ):
        return text
    return AUTHOR_METADATA_PAREN_NAME_REGEX.sub("", text)


HEADING_TRAILING_EN_PAREN_REGEX = re.compile(
    r"(?P<prefix>.*?[\u4e00-\u9fff][^()（）\n]{0,80})\s*[（(]\s*[A-Za-z][A-Za-z0-9&.,\-–—:;/'\" ]{1,120}\s*[）)]\s*$"
)


def normalize_heading_text(text: str) -> str:
    if not text:
        return text
    match = HEADING_TRAILING_EN_PAREN_REGEX.match(text)
    if not match:
        return text
    return normalize_text(match.group("prefix"))


def normalize_translated_block_text(
    text: str,
    block: Dict[str, Any],
    *,
    keep_preservable_placeholders: bool,
) -> str:
    normalized = restore_non_preservable_inline_placeholders(
        text,
        block,
        keep_preservable=keep_preservable_placeholders,
    )
    if str(block.get("blockType") or "") == "heading" or str(block.get("role") or "") == "heading":
        normalized = normalize_heading_text(normalized)
    if str(block.get("blockType") or "") in {"metadata", "page_header", "page_footer"}:
        normalized = normalize_author_metadata_text(normalized, block)
    return normalize_text(normalized)


def should_use_mixed_textbox(block: Dict[str, Any]) -> bool:
    placeholders = block.get("inlineFormulaPlaceholders") or {}
    if not placeholders:
        return False
    return str(block.get("blockType") or "") == "body"


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

    for line_index, line in enumerate(lines):
        current_x = float(resolve_block_line_bounds(rect, block, line_index)["leftX"])
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
    block: Dict[str, Any],
    rect,
    font_size: float,
    lineheight: float,
    measure_font,
    fitz,
    font_role: str,
    bold: bool,
    **font_options,
):
    line_tops = [rect.y0 + index * font_size * lineheight for index in range(len(lines))]

    for line_index, line in enumerate(lines):
        line_font_options = font_options
        line_measure_font = measure_font
        style_font_role = font_role
        style_bold = bold
        style_preferred = get_preferred_text_style(block, font_role, bold)
        if should_apply_source_line_styles(block):
            style = get_source_line_style(block, line_index, font_role, bold)
            style_font_role = str(style["font_role"])
            style_bold = bool(style["bold"])
            style_preferred = str(style["preferred_style"])
            line_font_options = line_style_font_options(
                block,
                line_index,
                font_role,
                bold,
                "".join(
                    str(token.get("text", "") or "")
                    for token in line
                    if token.get("type") == "text"
                ),
            )
            line_measure_font = create_measure_font(fitz, line_font_options)
        ascender = float(getattr(line_measure_font, "ascender", 1.0) or 1.0)
        current_x = float(resolve_block_line_bounds(rect, block, line_index)["leftX"])
        baseline_y = line_tops[line_index] + font_size * ascender
        for token in line:
            if token["type"] == "formula":
                current_x += float(token.get("width", 0.0))
                continue
            token_text = str(token.get("text", "") or "")
            if token_text:
                current_x += insert_script_split_line(
                    shape,
                    fitz,
                    (current_x, baseline_y),
                    token_text,
                    font_size,
                    line_font_options,
                    style_font_role,
                    style_bold,
                    style_preferred,
                    color=font_options.get("color", (0, 0, 0)),
                    block=block,
                    line_index=line_index,
                )
                continue
            current_x += float(token.get("width", 0.0))


def fit_textbox_with_uniform_block_style(
    page,
    rect,
    text: str,
    block: Dict[str, Any],
    font_size: float,
    rotation: int,
    fitz,
    min_font_size: float = 5.0,
    debug_visuals: bool = False,
) -> bool:
    if rotation != 0:
        return False
    layout_lines = block.get("layoutLines") or []
    first_item = None
    for line in layout_lines:
        for item in line.get("items", []) or []:
            if item.get("type") == "text" and normalize_text(str(item.get("text", "") or "")):
                first_item = item
                break
        if first_item is not None:
            break
    if first_item is None:
        return False

    style = source_item_visual_style(first_item, block, get_font_role(block))
    font_options = resolve_font_options(
        text,
        bold=bool(style["bold"]),
        font_role=str(style["font_role"]),
        preferred_style=str(style["preferred_style"]),
        family_class=str(style["family_class"]),
    )
    color = tuple(style["color"])
    size = max(min(font_size or style["font_size"] or 10, 36), min_font_size)
    measure_font = create_measure_font(fitz, font_options)
    preserve_source_breaks = should_preserve_source_line_breaks(block, str(style["font_role"]))
    use_body_wrap = should_use_body_bbox_wrap(block, str(style["font_role"]))

    while size >= min_font_size:
        if use_body_wrap:
            lineheight = 1.05 if style["bold"] else 1.1
            if has_irregular_body_wrap_shape(block) or has_dynamic_body_line_bounds(block):
                line_specs = wrap_body_text_to_line_templates(
                    text,
                    rect,
                    size,
                    measure_font,
                    block,
                    lineheight=lineheight,
                )
                if line_specs and render_body_wrapped_line_specs(
                    page,
                    fitz,
                    rect,
                    line_specs,
                    size,
                    block,
                    str(style["font_role"]),
                    bool(style["bold"]),
                    str(style["preferred_style"]),
                    lineheight,
                    color=color,
                ):
                    return True
                size -= 0.5
                continue

            wrapped = wrap_body_text_to_bbox(text, rect, size, measure_font, block)
            logical_lines = [line for line in wrapped.splitlines() if line.strip()]
            if logical_lines and render_body_wrapped_lines(
                page,
                fitz,
                rect,
                logical_lines,
                size,
                block,
                str(style["font_role"]),
                bool(style["bold"]),
                str(style["preferred_style"]),
                lineheight,
                color=color,
            ):
                return True
            size -= 0.5
            continue

        lineheight = 1.05 if style["bold"] else 1.1
        wrapped = (
            wrap_text_by_source_line_breaks(text, block, rect, size, measure_font)
            if preserve_source_breaks
            else wrap_text_for_box_precise(text, rect, size, measure_font)
        )
        logical_lines = [line for line in wrapped.splitlines() if line.strip()]
        if logical_lines:
            line_specs = build_line_specs_from_logical_lines(
                logical_lines,
                rect,
                size,
                lineheight,
                block,
            )
            if line_specs and render_text_line_specs(
                page,
                fitz,
                rect,
                line_specs,
                size,
                block,
                str(style["font_role"]),
                bool(style["bold"]),
                str(style["preferred_style"]),
                color=color,
            ):
                return True
        size -= 0.5
    return False


def build_style_run_line_templates(
    block: Dict[str, Any],
    fitz,
    scale: float,
    min_font_size: float,
) -> List[List[Dict[str, Any]]]:
    blueprint = block.get("_styleRunTemplateBlueprint")
    if not isinstance(blueprint, list):
        layout_lines = block.get("layoutLines") or []
        default_font_role = get_font_role(block)
        blueprint = []

        for line in layout_lines:
            runs: List[Dict[str, Any]] = []
            text_items = [
                item for item in (line.get("items", []) or [])
                if item.get("type") == "text" and normalize_text(str(item.get("text", "") or ""))
            ]
            if not text_items:
                continue

            for item in text_items:
                source_text = normalize_text(str(item.get("text", "") or ""))
                if not source_text:
                    continue
                style = source_item_visual_style(item, block, default_font_role)
                base_font_size = max(float(style["font_size"] or 0.0), min_font_size)
                font_options = resolve_font_options(
                    source_text,
                    bold=bool(style["bold"]),
                    font_role=str(style["font_role"]),
                    preferred_style=str(style["preferred_style"]),
                    family_class=str(style["family_class"]),
                )
                measure_font = create_measure_font(fitz, font_options)
                bbox = item.get("bbox") or []
                source_width = 0.0
                if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                    try:
                        source_width = max(float(bbox[2]) - float(bbox[0]), 0.0)
                    except Exception:
                        source_width = 0.0
                if source_width <= 0.0:
                    source_width = measure_text_width(measure_font, source_text, base_font_size)

                signature = source_visual_signature(style)
                if runs and runs[-1]["signature"] == signature:
                    runs[-1]["base_source_width"] += source_width
                else:
                    runs.append(
                        {
                            "signature": signature,
                            "font_options": font_options,
                            "font_role": str(style["font_role"]),
                            "bold": bool(style["bold"]),
                            "preferred_style": str(style["preferred_style"]),
                            "color": tuple(style["color"]),
                            "base_font_size": base_font_size,
                            "measure_font": measure_font,
                            "ascender": float(getattr(measure_font, "ascender", 1.0) or 1.0),
                            "base_source_width": source_width,
                        }
                    )

            if not runs:
                continue

            total_source_width = sum(float(run["base_source_width"]) for run in runs) or float(len(runs))
            for run in runs:
                run["target_ratio"] = float(run["base_source_width"]) / total_source_width
            blueprint.append(runs)

        block["_styleRunTemplateBlueprint"] = blueprint

    templates: List[List[Dict[str, Any]]] = []
    block_type = str(block.get("blockType") or "")
    body_base_size = max(float(block.get("fontSize") or 10.0), min_font_size)
    for line_runs in blueprint:
        scaled_runs: List[Dict[str, Any]] = []
        for base_run in line_runs:
            if block_type == "body":
                font_size = max(body_base_size * scale, min_font_size)
            else:
                font_size = max(float(base_run["base_font_size"]) * scale, min_font_size)
            source_width = max(float(base_run["base_source_width"]) * scale, font_size * 0.75)
            scaled_runs.append(
                {
                    "signature": base_run["signature"],
                    "font_options": dict(base_run["font_options"]),
                    "font_role": str(base_run["font_role"]),
                    "bold": bool(base_run["bold"]),
                    "preferred_style": str(base_run["preferred_style"]),
                    "color": tuple(base_run["color"]),
                    "font_size": font_size,
                    "measure_font": base_run["measure_font"],
                    "ascender": float(base_run["ascender"]),
                    "source_width": source_width,
                    "target_ratio": float(base_run["target_ratio"]),
                }
            )
        templates.append(scaled_runs)

    return templates


def measure_style_run_width(fitz, run: Dict[str, Any], text: str) -> float:
    return measure_script_split_line_width(
        fitz,
        text,
        float(run["font_size"]),
        dict(run["font_options"]),
        str(run["font_role"]),
        bool(run["bold"]),
        str(run["preferred_style"]),
        block=None,
        line_index=-1,
    )


def split_text_to_fit_style_run(
    fitz,
    run: Dict[str, Any],
    text: str,
    max_width: float,
) -> Tuple[str, str, float]:
    if not text:
        return "", "", 0.0

    if max_width <= 0.0:
        return "", text, 0.0

    whole_width = measure_style_run_width(fitz, run, text)
    if whole_width <= max_width:
        return text, "", whole_width

    first_char = text[:1]
    first_char_width = measure_style_run_width(fitz, run, first_char)
    if first_char_width > max_width:
        return first_char, text[1:], first_char_width

    low = 1
    high = len(text)
    best_len = 1
    best_width = first_char_width

    while low <= high:
        mid = (low + high) // 2
        candidate = text[:mid]
        candidate_width = measure_style_run_width(fitz, run, candidate)
        if candidate_width <= max_width:
            best_len = mid
            best_width = candidate_width
            low = mid + 1
        else:
            high = mid - 1

    return text[:best_len], text[best_len:], best_width


def consume_style_run_piece(
    fitz,
    run: Dict[str, Any],
    queue: List[str],
    queue_index: int,
    queue_remainder: str,
    max_width: float,
    *,
    trim_leading: bool,
) -> Tuple[str, int, str, float]:
    while True:
        token = queue_remainder if queue_remainder else (queue[queue_index] if queue_index < len(queue) else "")
        if not token:
            return "", queue_index, "", 0.0

        if trim_leading:
            token = token.lstrip()
            if not token:
                queue_remainder = ""
                queue_index += 1
                continue
            queue_remainder = token

        piece, remainder, piece_width = split_text_to_fit_style_run(fitz, run, token, max_width)
        if not piece:
            return "", queue_index, queue_remainder, 0.0

        if remainder:
            return piece, queue_index, remainder, piece_width

        return piece, queue_index + 1, "", piece_width


def layout_text_with_style_run_templates(
    fitz,
    text: str,
    templates: List[List[Dict[str, Any]]],
    rect,
    block: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    normalized = normalize_text(text)
    if not normalized or not templates:
        return []

    tokens = tokenize_plain_text(normalized)
    if not tokens:
        return []

    visual_lines: List[Dict[str, Any]] = []
    queue_index = 0
    queue_remainder = ""
    template_index = 0

    while queue_index < len(tokens) or queue_remainder:
        template = templates[min(template_index, len(templates) - 1)]
        line_bounds = resolve_block_line_bounds(rect, block, template_index)
        line_top = resolve_block_line_top(
            rect,
            block,
            template_index,
            float(template[0]["font_size"]) if template else 10.0,
            1.1,
        )
        max_width = max(float(line_bounds["width"]), 1.0)
        line_segments: List[Dict[str, Any]] = []
        line_width = 0.0
        for run_index, run_template in enumerate(template):
            run = dict(run_template)
            run.pop("signature", None)
            run.pop("source_width", None)
            remaining_line_width = max_width - line_width
            if remaining_line_width <= 1e-6:
                break

            soft_target = (
                remaining_line_width
                if run_index == len(template) - 1
                else max(float(run.get("target_ratio", 0.0)) * max_width, float(run["font_size"]) * 0.8)
            )

            segment_text = ""
            segment_width = 0.0
            while queue_index < len(tokens) or queue_remainder:
                source_is_remainder = bool(queue_remainder)
                token = queue_remainder if source_is_remainder else tokens[queue_index]
                if not token:
                    if source_is_remainder:
                        queue_remainder = ""
                    else:
                        queue_index += 1
                    continue

                if line_width <= 1e-6 and segment_width <= 1e-6:
                    token = token.lstrip()
                    if not token:
                        if source_is_remainder:
                            queue_remainder = ""
                        else:
                            queue_index += 1
                        continue
                    if source_is_remainder:
                        queue_remainder = token

                available_width = max_width - line_width - segment_width
                if available_width <= 1e-6:
                    break

                token_width = measure_style_run_width(fitz, run, token)

                if (
                    line_width <= 1e-6
                    and segment_width <= 1e-6
                    and is_hanging_punctuation_token(token)
                    and visual_lines
                ):
                    previous_line = visual_lines[-1]
                    previous_width = sum(float(segment.get("width", 0.0)) for segment in previous_line.get("segments", []))
                    hanging_tolerance = max(float(run["font_size"]) * 0.7, 2.0)
                    if previous_width + token_width <= float(previous_line.get("maxWidth") or max_width) + hanging_tolerance:
                        previous_segments = previous_line.get("segments", [])
                        if previous_segments:
                            previous_last = previous_segments[-1]
                            same_style = (
                                dict(previous_last.get("font_options") or {}) == dict(run["font_options"])
                                and str(previous_last.get("font_role") or "") == str(run["font_role"])
                                and bool(previous_last.get("bold")) == bool(run["bold"])
                                and str(previous_last.get("preferred_style") or "") == str(run["preferred_style"])
                                and tuple(previous_last.get("color") or ()) == tuple(run["color"])
                                and abs(float(previous_last.get("font_size") or 0.0) - float(run["font_size"])) <= 1e-6
                            )
                            if same_style:
                                previous_last["text"] = f"{previous_last['text']}{token}"
                                previous_last["width"] = float(previous_last.get("width", 0.0)) + token_width
                            else:
                                previous_segments.append(
                                    {
                                        "text": token,
                                        "font_options": dict(run["font_options"]),
                                        "font_role": str(run["font_role"]),
                                        "bold": bool(run["bold"]),
                                        "preferred_style": str(run["preferred_style"]),
                                        "color": tuple(run["color"]),
                                        "font_size": float(run["font_size"]),
                                        "ascender": float(run["ascender"]),
                                        "width": float(token_width),
                                    }
                                )
                        if source_is_remainder:
                            queue_remainder = ""
                        else:
                            queue_index += 1
                        continue

                if token_width <= available_width:
                    if (
                        run_index != len(template) - 1
                        and segment_text
                        and segment_width + token_width > soft_target
                    ):
                        break
                    segment_text += token
                    segment_width += token_width
                    if source_is_remainder:
                        queue_remainder = ""
                    else:
                        queue_index += 1
                    continue

                if segment_text:
                    break

                if normalize_text(token) and re.fullmatch(r"[A-Za-z0-9_]+(?:['-][A-Za-z0-9_]+)*\s*", token):
                    break

                piece, remainder, piece_width = split_text_to_fit_style_run(fitz, run, token, available_width)
                if not piece:
                    break
                segment_text = piece
                segment_width = piece_width
                if remainder:
                    queue_remainder = remainder
                else:
                    if source_is_remainder:
                        queue_remainder = ""
                    else:
                        queue_index += 1
                break

            if segment_text:
                line_segments.append(
                    {
                        "text": segment_text,
                        "font_options": dict(run["font_options"]),
                        "font_role": str(run["font_role"]),
                        "bold": bool(run["bold"]),
                        "preferred_style": str(run["preferred_style"]),
                        "color": tuple(run["color"]),
                        "font_size": float(run["font_size"]),
                        "ascender": float(run["ascender"]),
                        "width": float(segment_width),
                    }
                )
                line_width += segment_width

            if not (queue_index < len(tokens) or queue_remainder):
                break

        if not line_segments and (queue_index < len(tokens) or queue_remainder):
            fallback_run = dict(template[0])
            fallback_run.pop("signature", None)
            fallback_run.pop("source_width", None)
            token = queue_remainder if queue_remainder else tokens[queue_index]
            token = token.lstrip()
            if token:
                piece, remainder, piece_width = split_text_to_fit_style_run(fitz, fallback_run, token, max_width)
                if piece:
                    line_segments.append(
                        {
                            "text": piece,
                            "font_options": dict(fallback_run["font_options"]),
                            "font_role": str(fallback_run["font_role"]),
                            "bold": bool(fallback_run["bold"]),
                            "preferred_style": str(fallback_run["preferred_style"]),
                            "color": tuple(fallback_run["color"]),
                            "font_size": float(fallback_run["font_size"]),
                            "ascender": float(fallback_run["ascender"]),
                            "width": float(piece_width),
                        }
                    )
                    if remainder:
                        queue_remainder = remainder
                    else:
                        if queue_remainder:
                            queue_remainder = ""
                        else:
                            queue_index += 1

        if not line_segments:
            break

        visual_lines.append(
            {
                "segments": line_segments,
                "leftX": float(line_bounds["leftX"]),
                "rightX": float(line_bounds["rightX"]),
                "maxWidth": max_width,
                "lineTop": float(line_top),
            }
        )
        template_index += 1

    return visual_lines


def fit_textbox_with_mixed_line_span_styles(
    page,
    rect,
    text: str,
    block: Dict[str, Any],
    font_size: float,
    fitz,
    min_font_size: float = 5.0,
) -> bool:
    if int(block.get("rotation") or 0) != 0:
        return False

    layout_lines = block.get("layoutLines") or []
    source_line_texts = []
    for line in layout_lines:
        items = [item for item in (line.get("items", []) or []) if item.get("type") == "text"]
        source_line_texts.append("".join(str(item.get("text", "") or "") for item in items))
    if not source_line_texts:
        return False

    base_size = max(float(block.get("fontSize") or font_size or 10.0), 1.0)
    lineheight = 1.1
    max_size = max(min(font_size or base_size, 36), min_font_size)

    def compute_layout(candidate_size: float) -> Optional[Tuple[List[Dict[str, Any]], List[float]]]:
        scale = candidate_size / max(base_size, 1.0)
        templates = build_style_run_line_templates(block, fitz, scale, min_font_size)
        if not templates:
            return None
        visual_lines = layout_text_with_style_run_templates(fitz, text, templates, rect, block)
        if not visual_lines:
            return None

        line_heights = [
            max(float(segment["font_size"]) for segment in line["segments"]) * lineheight
            for line in visual_lines
            if line.get("segments")
        ]
        total_height = sum(line_heights)
        if total_height > rect.height + 1:
            return None

        current_y = rect.y0
        for visual_index, line in enumerate(visual_lines):
            current_x = float(line["leftX"])
            line_right_x = float(line["rightX"])
            for segment in line["segments"]:
                if current_x + float(segment["width"]) > line_right_x + 1e-3:
                    return None
                current_x += float(segment["width"])
            current_y += line_heights[visual_index]
            if current_y > rect.y1 + 1e-3:
                return None
        return visual_lines, line_heights

    low = int(math.ceil(min_font_size * 2.0))
    high = int(math.floor(max_size * 2.0))
    best_layout: Optional[Tuple[float, List[Dict[str, Any]], List[float]]] = None

    while low <= high:
        mid = (low + high) // 2
        candidate_size = mid / 2.0
        result = compute_layout(candidate_size)
        if result is None:
            high = mid - 1
        else:
            visual_lines, line_heights = result
            best_layout = (candidate_size, visual_lines, line_heights)
            low = mid + 1

    if best_layout is None:
        return False

    _, visual_lines, line_heights = best_layout
    shape = page.new_shape()
    for visual_index, line in enumerate(visual_lines):
        current_x = float(line["leftX"])
        line_top = float(line.get("lineTop") or rect.y0)
        for segment in line["segments"]:
            insert_script_split_line(
                shape,
                fitz,
                (current_x, line_top + float(segment["font_size"]) * float(segment["ascender"])),
                str(segment["text"]),
                float(segment["font_size"]),
                dict(segment["font_options"]),
                str(segment["font_role"]),
                bool(segment["bold"]),
                str(segment["preferred_style"]),
                color=tuple(segment["color"]),
                block=None,
                line_index=-1,
            )
            current_x += float(segment["width"])
    shape.commit()
    return True


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
    family_class = block_style_family_class(block, font_role)
    font_options = resolve_font_options(
        text,
        bold=bold,
        font_role=font_role,
        preferred_style=preferred_style,
        family_class=family_class,
    )
    measure_font = create_measure_font(fitz, font_options)
    lineheight = 1.05 if bold else 1.1
    source_page_number = max(int(block.get("page", 1)) - 1, 0)
    primary_color = block_primary_text_color(block)

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
            block,
            rect,
            size,
            lineheight,
            measure_font,
            fitz,
            font_role,
            bold,
            color=primary_color,
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


def insert_source_clip_as_image(
    page,
    source_doc,
    source_page_number: int,
    dest_rect,
    clip_rect,
    *,
    zoom: float = 1.0,
) -> bool:
    if source_doc is None or dest_rect.is_empty or clip_rect.is_empty:
        return False
    try:
        source_page = source_doc[source_page_number]
        matrix = None
        if zoom and zoom > 1.0:
            matrix = source_page.derotation_matrix.prescale(float(zoom), float(zoom))
        pix = source_page.get_pixmap(
            matrix=matrix,
            clip=clip_rect,
            alpha=False,
        )
        page.insert_image(dest_rect, pixmap=pix, overlay=True, keep_proportion=False)
        return True
    except Exception:
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

    if block.get("blockType") == "reference_block" or block.get("doclingLabel") == "reference":
        block["preserveOriginal"] = True

    if block.get("preserveOriginal"):
        if source_doc is not None:
            source_page_number = max(int(block.get("page", 1)) - 1, 0)
            clip = source_doc[source_page_number].rect & rect
            if clip.is_empty:
                return False
            if insert_source_clip_as_image(page, source_doc, source_page_number, rect, clip):
                return True
            page.show_pdf_page(rect, source_doc, source_page_number, clip=clip, overlay=True)
            return True
        return None

    raw_translated = sanitize_translated_text(block.get("translatedText") or "")
    if not raw_translated and block.get("preserveOriginal"):
        raw_translated = sanitize_translated_text(block.get("text") or "")
    if is_translation_meta_note(raw_translated):
        return False
    if is_orphan_punctuation_translation(block, raw_translated):
        return False
    translated = normalize_translated_block_text(
        raw_translated,
        block,
        keep_preservable_placeholders=bool(source_doc is not None and should_use_mixed_textbox(block)),
    )
    if not translated:
        return None

    default_style = build_block_default_style(block)
    block["_renderDefaultStyle"] = default_style
    rotation = int(block.get("rotation") or 0)
    bold = str(default_style.get("weight") or "regular") == "bold"
    font_role = str(default_style.get("fontRole") or get_font_role(block))
    base_font_size = float(block.get("fontSize") or 10)
    if bold:
        min_font_size = 5.5
    elif block.get("hasSizeJump"):
        min_font_size = 4.8
    else:
        min_font_size = 4.5

    can_use_mixed = should_use_mixed_textbox(block) and source_doc is not None
    success = False
    use_visual_style_reflow = (
        not block_has_uniform_visual_style(block)
        and str(block.get("blockType") or "") in {"heading", "metadata", "drop_cap"}
    )
    use_uniform_block_style = (
        block_has_uniform_visual_style(block)
        and str(block.get("blockType") or "") in {"heading", "metadata", "body", "drop_cap"}
    )

    if str(block.get("blockType") or "") == "drop_cap":
        success = fit_drop_cap_block(
            page,
            rect,
            translated,
            block,
            base_font_size,
            fitz,
            min_font_size=min_font_size,
        )
    elif use_uniform_block_style:
        success = fit_textbox_with_uniform_block_style(
            page,
            rect,
            translated,
            block,
            base_font_size,
            rotation,
            fitz,
            min_font_size=min_font_size,
            debug_visuals=debug_visuals,
        )
    elif use_visual_style_reflow:
        success = fit_textbox_with_mixed_line_span_styles(
            page,
            rect,
            translated,
            block,
            base_font_size,
            fitz,
            min_font_size=min_font_size,
        )

    if not success and can_use_mixed:
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
            or not should_use_mixed_textbox(block)
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
            source_doc=source_doc,
        )

    block.pop("_renderDefaultStyle", None)
    return success




