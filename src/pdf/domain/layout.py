from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from domain.core import *

def _non_empty_layout_line_texts(block: Dict[str, Any]) -> List[str]:
    line_texts: List[str] = []
    for line in block.get("layoutLines") or []:
        line_text = normalize_text(
            "".join(str(item.get("text", "") or "") for item in (line.get("items", []) or []))
        )
        if line_text:
            line_texts.append(line_text)
    return line_texts


PROSE_CONNECTOR_REGEX = re.compile(
    r"\b(?:and|but|if|because|when|while|that|which|who|they|we|however|therefore)\b"
    r"|(?:如果|但是|然而|因为|所以|而且|并且|他们|我们|这种|这样|于是)"
)
PROSE_LINE_CONTINUATION_REGEX = re.compile(
    r"^(?:and|but|if|because|when|while|that|which|who|they|we|however|therefore)\b"
    r"|^(?:如果|但是|然而|因为|所以|而且|并且|他们|我们|这种|这样|于是)"
)
PROSE_SENTENCE_END_REGEX = re.compile(r'[。！？?!]["”’»）)]?$|[.]["”’»）)]?$')


def looks_like_prose_block(block: Dict[str, Any]) -> bool:
    text = normalize_text(block.get("text") or "")
    if not text or SECTION_HEADING_REGEX.match(text):
        return False

    line_texts = _non_empty_layout_line_texts(block)
    line_count = len(line_texts)
    if line_count == 0:
        return False

    punctuation_count = len(re.findall(r"[，。；：,.!?]", text))
    comma_like_count = len(re.findall(r"[，,；;：:]", text))
    token_count = len(re.findall(r"\S+", text))
    char_count = len(text)
    has_connector = bool(PROSE_CONNECTOR_REGEX.search(text))
    ends_like_sentence = bool(PROSE_SENTENCE_END_REGEX.search(text))
    is_quoted = text[:1] in {'"', "“", "‘", "'"} or text[-1:] in {'"', "”", "’", "'"}
    second_line_continues = (
        line_count >= 2
        and bool(PROSE_LINE_CONTINUATION_REGEX.search(line_texts[1]))
    )

    prose_signals = 0
    if punctuation_count >= 2:
        prose_signals += 1
    if token_count >= 10 or char_count >= 40:
        prose_signals += 1
    if has_connector:
        prose_signals += 1
    if ends_like_sentence:
        prose_signals += 1
    if second_line_continues:
        prose_signals += 1

    if line_count >= 3 and (punctuation_count >= 1 or has_connector):
        return True
    if is_quoted and (punctuation_count >= 1 or has_connector) and char_count >= 28:
        return True
    if line_count >= 2 and punctuation_count >= 2 and (token_count >= 8 or char_count >= 32):
        return True
    if prose_signals >= 3:
        return True
    return False


def is_paragraph_like_heading_candidate(
    block: Dict[str, Any],
    page_body_font_size: float,
    page_body_width: Optional[float] = None,
) -> bool:
    text = normalize_text(block.get("text") or "")
    if not text or SECTION_HEADING_REGEX.match(text):
        return False

    if looks_like_prose_block(block):
        return True

    line_texts = _non_empty_layout_line_texts(block)
    line_count = len(line_texts)
    if line_count <= 1:
        return False

    punctuation_count = len(re.findall(r"[，。；：.!?]", text))
    token_count = len(re.findall(r"\S+", text))
    font_size = float(block.get("fontSize") or 0.0)
    width = block_width(block)

    near_body_size = font_size <= max(page_body_font_size * 1.45, page_body_font_size + 4.0)
    width_near_body = (
        page_body_width is not None
        and width >= page_body_width * 0.72
    )

    if line_count >= 3 and len(text) >= 60 and punctuation_count >= 1:
        return True
    if near_body_size and line_count >= 2 and len(text) >= 90 and punctuation_count >= 1:
        return True
    if near_body_size and line_count >= 2 and token_count >= 14 and punctuation_count >= 1:
        return True
    if width_near_body and line_count >= 2 and len(text) >= 70 and punctuation_count >= 1:
        return True
    return False


def looks_like_heading(text: str, font_size: float, page_body_font_size: float) -> bool:
    normalized = normalize_text(text)
    if not normalized or len(normalized) > 140:
        return False
    if SECTION_HEADING_REGEX.match(normalized):
        return True
    if font_size >= max(page_body_font_size * 1.18, page_body_font_size + 1.2):
        return True
    return False


def should_demote_heading_block(
    block: Dict[str, Any],
    page_body_font_size: float,
    page_body_width: Optional[float] = None,
) -> bool:
    if str(block.get("role") or "") != "heading":
        return False
    return is_paragraph_like_heading_candidate(
        block,
        page_body_font_size,
        page_body_width,
    )


def is_heading_prose_continuation(
    previous_block: Dict[str, Any],
    block: Dict[str, Any],
) -> bool:
    if not previous_block or not block:
        return False
    if str(block.get("role") or "") != "heading":
        return False
    if str(block.get("doclingLabel") or "") not in {"section_header", "title"}:
        return False
    if int(previous_block.get("page") or 0) != int(block.get("page") or 0):
        return False

    prev_text = normalize_text(previous_block.get("text") or "")
    text = normalize_text(block.get("text") or "")
    if not prev_text or not text:
        return False

    prev_bbox = previous_block.get("bbox") or [0, 0, 0, 0]
    bbox = block.get("bbox") or [0, 0, 0, 0]
    if len(prev_bbox) != 4 or len(bbox) != 4:
        return False

    prev_font_size = float(previous_block.get("fontSize") or 0.0)
    font_size = float(block.get("fontSize") or 0.0)
    if prev_font_size <= 0 or font_size <= 0:
        return False
    if abs(prev_font_size - font_size) > max(prev_font_size * 0.12, 1.5):
        return False

    y_gap = float(bbox[1]) - float(prev_bbox[3])
    if y_gap < -max(font_size * 0.45, 10.0) or y_gap > max(font_size * 0.9, 14.0):
        return False

    left_delta = abs(float(bbox[0]) - float(prev_bbox[0]))
    right_delta = abs(float(bbox[2]) - float(prev_bbox[2]))
    if left_delta > max(font_size * 1.4, 28.0) and right_delta > max(font_size * 1.8, 34.0):
        return False

    in_prose_sequence = bool(previous_block.get("_proseHeadingSequence")) or looks_like_prose_block(
        previous_block
    )
    if not in_prose_sequence:
        return False

    punctuation_count = len(re.findall(r"[，。；：,.!?]", text))
    token_count = len(re.findall(r"\S+", text))
    char_count = len(text)
    is_short_heading_like = punctuation_count == 0 and token_count <= 5 and char_count <= 22
    if is_short_heading_like:
        return False
    return True


def is_reference_section_heading(block: Dict[str, Any]) -> bool:
    text = normalize_text(block.get("text") or "").lower()
    if not text:
        return False
    if text in {"references", "bibliography", "参考文献"}:
        return True
    return False


def has_section_heading_signal(block: Dict[str, Any]) -> bool:
    if block.get("role") == "heading":
        return True
    if block.get("doclingLabel") in ("section_header", "title"):
        return True
    if str(block.get("blockType") or "") == "heading":
        return True
    return False


def mark_reference_sections(pages_blocks: List[List[Dict[str, Any]]]) -> None:
    ordered_blocks: List[Dict[str, Any]] = []
    for page_blocks in pages_blocks:
        ordered_blocks.extend(
            sorted(
                page_blocks,
                key=lambda block: (
                    int(block.get("page") or 0),
                    float(block["bbox"][1]),
                    float(block["bbox"][0]),
                ),
            )
        )

    in_reference_section = False

    for block in ordered_blocks:
        if has_section_heading_signal(block):
            if is_reference_section_heading(block):
                in_reference_section = True
                continue
            if in_reference_section:
                in_reference_section = False
                continue

        if not in_reference_section:
            continue

        block["blockType"] = "reference_block"
        block["preserveOriginal"] = True
        block["role"] = "preserved"
        block["preserveReason"] = "reference_section"


def block_width(block: Dict[str, Any]) -> float:
    bbox = block.get("bbox") or [0, 0, 0, 0]
    if len(bbox) != 4:
        return 0.0
    return max(float(bbox[2]) - float(bbox[0]), 0.0)


def _visible_characters(text: str) -> List[str]:
    return [char for char in normalize_text(text) if not char.isspace()]


def _line_bbox(line: Dict[str, Any]) -> Optional[List[float]]:
    bbox = line.get("bbox") or [0, 0, 0, 0]
    if len(bbox) != 4:
        return None
    try:
        return [float(v) for v in bbox]
    except Exception:
        return None


def _looks_like_drop_cap_candidate(block: Dict[str, Any], page_body_font_size: float) -> bool:
    visible_chars = _visible_characters(block.get("text") or "")
    if len(visible_chars) != 1:
        return False
    if re.fullmatch(r"[\W_]", visible_chars[0], flags=re.UNICODE):
        return False
    if block.get("preserveOriginal"):
        return False

    bbox = block.get("bbox") or [0, 0, 0, 0]
    if len(bbox) != 4:
        return False
    try:
        x0, y0, x1, y1 = [float(v) for v in bbox]
    except Exception:
        return False
    width = max(x1 - x0, 0.0)
    height = max(y1 - y0, 0.0)
    font_size = float(block.get("fontSize") or 0.0)
    page_width = float(block.get("pageWidth") or 0.0)
    line_count = len(_non_empty_layout_line_texts(block))

    if font_size < max(page_body_font_size * 1.8, page_body_font_size + 6.0):
        return False
    if height < max(page_body_font_size * 2.2, 18.0):
        return False
    if width > max(font_size * 1.6, page_width * 0.12 if page_width > 0 else font_size * 2.2):
        return False
    if line_count > 2:
        return False
    return True


def _drop_cap_host_score(
    drop_block: Dict[str, Any],
    host_block: Dict[str, Any],
    page_body_font_size: float,
) -> Optional[Dict[str, float]]:
    if str(host_block.get("blockType") or "") != "body":
        return None
    if host_block.get("preserveOriginal"):
        return None

    host_text = normalize_text(host_block.get("text") or "")
    if len(host_text) < 32:
        return None

    drop_bbox = drop_block.get("bbox") or [0, 0, 0, 0]
    host_bbox = host_block.get("bbox") or [0, 0, 0, 0]
    if len(drop_bbox) != 4 or len(host_bbox) != 4:
        return None
    dx0, dy0, dx1, dy1 = [float(v) for v in drop_bbox]
    hx0, hy0, hx1, hy1 = [float(v) for v in host_bbox]
    if hx1 <= dx1:
        return None

    vertical_overlap = max(0.0, min(dy1, hy1) - max(dy0, hy0))
    if vertical_overlap <= max(page_body_font_size * 0.6, 6.0):
        return None

    first_lines = [line for line in (host_block.get("layoutLines") or []) if _line_bbox(line)]
    if not first_lines:
        return None
    early_lines = first_lines[: min(len(first_lines), 3)]
    if not early_lines:
        return None

    overlap_lines = 0
    wrapped_right_of_drop = 0
    wrapped_below_drop = 0
    min_line_x0 = None
    anchor_top = None
    for line in early_lines:
        bbox = _line_bbox(line)
        if bbox is None:
            continue
        lx0, ly0, lx1, ly1 = bbox
        min_line_x0 = lx0 if min_line_x0 is None else min(min_line_x0, lx0)
        if min(ly1, dy1) - max(ly0, dy0) > max(page_body_font_size * 0.4, 4.0):
            overlap_lines += 1
            if lx0 >= dx1 - max(page_body_font_size * 0.35, 4.0):
                wrapped_right_of_drop += 1
                anchor_top = ly0 if anchor_top is None else min(anchor_top, ly0)
        elif ly0 >= dy1 - max(page_body_font_size * 0.35, 4.0):
            wrapped_below_drop += 1

    if overlap_lines == 0:
        return None
    if wrapped_right_of_drop == 0:
        return None

    left_gap = max(hx0 - dx1, 0.0)
    top_gap = abs(hy0 - dy0)
    score = 0.0
    score += overlap_lines * 8.0
    score += wrapped_right_of_drop * 10.0
    score += wrapped_below_drop * 3.0
    score -= left_gap
    score -= top_gap * 0.45
    if min_line_x0 is not None:
        score -= abs(min_line_x0 - dx1) * 0.35
    if anchor_top is None:
        anchor_top = hy0
    return {"score": score, "anchorTop": float(anchor_top)}


def mark_drop_cap_relations(page_blocks: List[Dict[str, Any]], page_body_font_size: float) -> None:
    ordered_blocks = sorted(
        page_blocks,
        key=lambda block: (
            float((block.get("bbox") or [0, 0, 0, 0])[1]),
            float((block.get("bbox") or [0, 0, 0, 0])[0]),
        ),
    )
    used_host_ids: Set[str] = set()

    for block in ordered_blocks:
        if not _looks_like_drop_cap_candidate(block, page_body_font_size):
            continue

        best_host = None
        best_score = None
        best_anchor_top = None
        for host in ordered_blocks:
            if host is block or host.get("id") in used_host_ids:
                continue
            match = _drop_cap_host_score(block, host, page_body_font_size)
            if match is None:
                continue
            score = float(match["score"])
            if best_score is None or score > best_score:
                best_score = score
                best_host = host
                best_anchor_top = float(match["anchorTop"])

        if best_host is None:
            continue

        drop_char = "".join(_visible_characters(block.get("text") or "")[:1])
        host_text = normalize_text(best_host.get("text") or "")
        if not drop_char or not host_text:
            continue

        block["role"] = "drop_cap"
        block["blockType"] = "drop_cap"
        block["layoutIntent"] = "drop_cap"
        block["isBodyLike"] = False
        block["dropCapHostId"] = best_host["id"]
        if best_anchor_top is not None:
            block["dropCapAnchorTop"] = best_anchor_top

        best_host["dropCap"] = {
            "sourceBlockId": block["id"],
            "text": drop_char,
            "bbox": list(block.get("bbox") or []),
            "fontSize": float(block.get("fontSize") or 0.0),
            "anchorTop": float(best_anchor_top if best_anchor_top is not None else block.get("bbox", [0, 0, 0, 0])[1]),
        }
        best_host["dropCapSourceId"] = block["id"]
        if not host_text.startswith(drop_char):
            best_host["text"] = f"{drop_char}{host_text}"
        used_host_ids.add(best_host["id"])


def build_wrap_shape_profile(block: Dict[str, Any]) -> Dict[str, Any]:
    bbox = block.get("bbox") or [0, 0, 0, 0]
    if len(bbox) != 4:
        return {"wrapShape": "regular", "wrapLineTemplates": []}

    base_x0 = float(bbox[0])
    base_x1 = float(bbox[2])
    base_width = max(base_x1 - base_x0, 0.0)
    if base_width <= 0:
        return {"wrapShape": "regular", "wrapLineTemplates": []}

    line_templates: List[Dict[str, float]] = []
    for line in block.get("layoutLines") or []:
        items = line.get("items", []) or []
        text_items = [
            item
            for item in items
            if item.get("type") == "text"
            and normalize_text(str(item.get("text", "") or ""))
        ]
        if not text_items:
            continue
        line_bbox = line.get("bbox") or [0, 0, 0, 0]
        if len(line_bbox) != 4:
            continue
        line_x0 = float(line_bbox[0])
        line_x1 = float(line_bbox[2])
        line_width = max(line_x1 - line_x0, 0.0)
        if line_width <= 0:
            continue
        line_templates.append(
            {
                "xOffset": max(line_x0 - base_x0, 0.0),
                "width": line_width,
            }
        )

    if len(line_templates) < 4:
        return {"wrapShape": "regular", "wrapLineTemplates": line_templates}

    widths = [float(template["width"]) for template in line_templates]
    offsets = [float(template["xOffset"]) for template in line_templates]
    max_width = max(widths)
    min_width = min(widths)
    width_variation = max_width - min_width
    if width_variation <= max(36.0, base_width * 0.14):
        return {"wrapShape": "regular", "wrapLineTemplates": line_templates}

    narrow_threshold = max_width - max(28.0, max_width * 0.18)
    narrow_indices = [index for index, width in enumerate(widths) if width <= narrow_threshold]
    if not narrow_indices:
        return {"wrapShape": "regular", "wrapLineTemplates": line_templates}

    runs: List[List[int]] = []
    current_run: List[int] = []
    for index in narrow_indices:
        if current_run and index != current_run[-1] + 1:
            runs.append(current_run)
            current_run = [index]
        else:
            current_run.append(index)
    if current_run:
        runs.append(current_run)

    longest_run = max(runs, key=len)
    if len(longest_run) < 2:
        return {"wrapShape": "regular", "wrapLineTemplates": line_templates}

    run_offsets = [offsets[index] for index in longest_run]
    run_widths = [widths[index] for index in longest_run]
    avg_offset = sum(run_offsets) / len(run_offsets)
    avg_width = sum(run_widths) / len(run_widths)
    right_inset = max_width - (avg_offset + avg_width)

    if avg_offset <= max(14.0, base_width * 0.05) and right_inset >= max(28.0, base_width * 0.12):
        wrap_shape = "inset_right"
    elif right_inset <= max(14.0, base_width * 0.05) and avg_offset >= max(18.0, base_width * 0.08):
        wrap_shape = "inset_left"
    else:
        wrap_shape = "complex"

    return {
        "wrapShape": wrap_shape,
        "wrapLineTemplates": line_templates,
    }


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


def resolve_layout_intent(
    block: Dict[str, Any],
    page_body_width: Optional[float],
    page_body_font_size: float,
) -> str:
    block_type = str(block.get("blockType") or "")
    text = normalize_text(block.get("text") or "")
    if not text:
        return "generic"
    if block_type not in ("metadata", "footnote"):
        return "generic"

    layout_lines = block.get("layoutLines") or []
    line_count = len(layout_lines)
    punctuation_count = len(re.findall(r"[，。；：.!?]", text))
    token_count = len(re.findall(r"\S+", text))
    width = block_width(block)
    page_width = max(float(block.get("pageWidth") or 1.0), 1.0)
    width_ratio = width / page_width if page_width > 0 else 0.0
    font_size = float(block.get("fontSize") or 0.0)
    page_height = max(float(block.get("pageHeight") or 1.0), 1.0)
    y0 = float((block.get("bbox") or [0, 0, 0, 0])[1])
    y1 = float((block.get("bbox") or [0, 0, 0, 0])[3])
    near_page_edge = y1 <= page_height * 0.18 or y0 >= page_height * 0.82

    if line_count >= 3:
        non_empty_lines = []
        line_token_counts = []
        line_width_ratios = []
        monospace_lines = 0
        for line in layout_lines:
            items = line.get("items", []) or []
            text_items = [
                item
                for item in items
                if item.get("type") == "text"
                and normalize_text(str(item.get("text", "") or ""))
            ]
            if not text_items:
                continue
            line_text = normalize_text(
                "".join(str(item.get("text", "") or "") for item in text_items)
            )
            if not line_text:
                continue
            non_empty_lines.append(line_text)
            line_token_counts.append(len(re.findall(r"\S+", line_text)))
            line_bbox = line.get("bbox") or [0, 0, 0, 0]
            if len(line_bbox) == 4:
                line_width_ratios.append(
                    max(float(line_bbox[2]) - float(line_bbox[0]), 0.0) / page_width
                )
            if any(bool(item.get("isMonospaceLike")) for item in text_items):
                monospace_lines += 1

        if non_empty_lines:
            avg_tokens = sum(line_token_counts) / max(len(line_token_counts), 1)
            width_spread = (
                max(line_width_ratios) - min(line_width_ratios)
                if len(line_width_ratios) >= 2
                else 0.0
            )

            if (
                len(text) >= 140
                and punctuation_count >= 2
                and avg_tokens >= 4
                and width_ratio >= 0.55
            ):
                return "note_paragraph"
            if (
                near_page_edge
                and len(text) >= 90
                and punctuation_count >= 1
                and avg_tokens >= 4
                and width_ratio >= 0.45
            ):
                return "note_paragraph"
            if avg_tokens <= 3.2 and width_spread >= 0.12 and monospace_lines >= 1:
                return "structured_fields"
            if avg_tokens <= 3.5 and punctuation_count == 0 and width_spread >= 0.08:
                return "structured_fields"

    if (
        len(text) >= 140
        and punctuation_count >= 2
        and token_count >= 18
        and abs(font_size - page_body_font_size) <= max(page_body_font_size * 0.25, 2.0)
        and (
            page_body_width is None
            or abs(width - page_body_width) <= max(page_body_width * 0.28, 36.0)
        )
    ):
        return "note_paragraph"

    return "structured_fields" if line_count >= 2 else "generic"


def resolve_block_type(
    block: Dict[str, Any],
    page_body_width: Optional[float],
    page_body_font_size: float,
) -> str:
    docling_label = str(block.get("doclingLabel") or "")
    text = normalize_text(block.get("text") or "")
    body_like = is_body_like_block(block, page_body_width, page_body_font_size)

    if bool(block.get("_demotedFromHeading")):
        return "body"

    if docling_label in ("title", "section_header"):
        return "heading"
    if docling_label == "caption":
        return "caption"
    if docling_label == "table":
        return "table_body"
    if docling_label == "formula":
        return "formula_display"
    if docling_label == "reference":
        return "reference_block"
    if docling_label == "footnote":
        return "footnote"
    if docling_label == "page_header":
        return "page_header"
    if docling_label == "page_footer":
        return "page_footer"
    if docling_label in (
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
    family_class: str = "serif",
) -> Dict[str, Any]:
    if not requires_cjk_font(text):
        if preferred_style == "monospace" or font_role == "code" or family_class == "mono":
            return {"fontname": "cour"}
        if family_class == "sans":
            if preferred_style == "bold_italic":
                return {"fontname": "helvBI"}
            if preferred_style == "italic":
                return {"fontname": "helvI"}
            if preferred_style == "bold" or font_role == "heading":
                return {"fontname": "helvB"}
            return {"fontname": "helvB" if bold else "helv"}
        if preferred_style == "bold_italic":
            return {"fontname": "Times-BoldItalic"}
        if preferred_style == "italic":
            return {"fontname": "Times-Italic"}
        if preferred_style == "bold" or font_role == "heading":
            return {"fontname": "Times-Bold"}
        return {"fontname": "Times-Bold" if bold else "Times-Roman"}

    configured_font = os.environ.get("PDF_FONT_FILE") or os.environ.get("WASABI_PDF_FONT")
    cjk_candidates: Dict[Tuple[str, str], List[Optional[str]]] = {
        ("serif", "regular"): [
            configured_font,
            r"C:\Windows\Fonts\SourceHanSerifSC-Regular.otf",
            r"C:\Windows\Fonts\NotoSerifCJKsc-Regular.otf",
            r"C:\Windows\Fonts\SourceHanSansSC-Regular.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Regular.otf",
            "/usr/share/fonts/opentype/adobe-source-han-serif/SourceHanSerifSC-Regular.otf",
            "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Regular.otf",
            r"C:\Windows\Fonts\simsun.ttc",
            r"C:\Windows\Fonts\SimSun-ExtB.ttf",
            r"C:\Windows\Fonts\NSimSun.ttf",
            r"C:\Windows\Fonts\STSONG.TTF",
            r"C:\Windows\Fonts\simfang.ttf",
            r"C:\Windows\Fonts\STFANGSO.TTF",
            r"C:\Windows\Fonts\FZJuZXFJW.TTF",
        ],
        ("serif", "bold"): [
            configured_font,
            r"C:\Windows\Fonts\SourceHanSerifSC-Bold.otf",
            r"C:\Windows\Fonts\NotoSerifCJKsc-Bold.otf",
            "/usr/share/fonts/opentype/adobe-source-han-serif/SourceHanSerifSC-Bold.otf",
            "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
            r"C:\Windows\Fonts\SourceHanSansSC-Bold.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Bold.otf",
            r"C:\Windows\Fonts\STSONG.TTF",
            r"C:\Windows\Fonts\simsun.ttc",
            r"C:\Windows\Fonts\NSimSun.ttf",
            r"C:\Windows\Fonts\simsunb.ttf",
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\msyhbd.ttc",
        ],
        ("sans", "regular"): [
            configured_font,
            r"C:\Windows\Fonts\SourceHanSansSC-Regular.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Regular.otf",
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\msyh.ttc",
            r"C:\Windows\Fonts\微软雅黑.ttf",
            r"C:\Windows\Fonts\simsun.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Regular.otf",
            "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
        ],
        ("sans", "bold"): [
            configured_font,
            r"C:\Windows\Fonts\SourceHanSansSC-Bold.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Bold.otf",
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\msyhbd.ttc",
            r"C:\Windows\Fonts\SourceHanSerifSC-Bold.otf",
            r"C:\Windows\Fonts\NotoSerifCJKsc-Bold.otf",
            "/usr/share/fonts/opentype/adobe-source-han-sans/SourceHanSansSC-Bold.otf",
            "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Bold.otf",
        ],
        ("mono", "regular"): [
            configured_font,
            r"C:\Windows\Fonts\NSimSun.ttf",
            r"C:\Windows\Fonts\simsun.ttc",
            r"C:\Windows\Fonts\SourceHanSansSC-Regular.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Regular.otf",
            "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Regular.otf",
        ],
        ("mono", "bold"): [
            configured_font,
            r"C:\Windows\Fonts\NSimSun.ttf",
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\SourceHanSansSC-Bold.otf",
            r"C:\Windows\Fonts\NotoSansCJKsc-Bold.otf",
            "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Bold.otf",
        ],
    }

    effective_family = "mono" if (family_class == "mono" or preferred_style == "monospace" or font_role == "code") else "serif"
    effective_weight = "bold" if (bold or preferred_style in {"bold", "bold_italic"} or font_role == "heading") else "regular"
    candidates = cjk_candidates.get((effective_family, effective_weight), cjk_candidates[("serif", "regular")])

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


