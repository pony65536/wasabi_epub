from __future__ import annotations

import json
import re
import time
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List, Tuple

from domain import common, rendering
from domain.core import is_short_byline_metadata_block, is_translation_meta_note


BACKGROUND_RENDER_ZOOM = 2.0
BRAND_LABEL_URL = "https://github.com/pony65536/wasabi_epub"
BRAND_LOGO_PATH = Path(__file__).resolve().parents[1] / "app" / "assets" / "wasabi.png"


def _fallback_output_path(output_pdf: str) -> str:
    target = Path(output_pdf)
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    return str(target.with_name(f"{target.stem}_{timestamp}{target.suffix}"))


def _split_first_visible_character(text: str) -> tuple[str, str]:
    source = str(text or "")
    for index, char in enumerate(source):
        if char.isspace():
            continue
        return char, f"{source[:index]}{source[index + 1:]}"
    return "", source


def _apply_drop_cap_translation_splits(blocks: List[Dict[str, Any]]) -> None:
    blocks_by_id = {
        str(block.get("id") or ""): block
        for block in blocks
        if str(block.get("id") or "")
    }
    for block in blocks:
        drop_cap = block.get("dropCap")
        if not isinstance(drop_cap, dict):
            continue
        source_block_id = str(drop_cap.get("sourceBlockId") or "")
        if not source_block_id:
            continue
        drop_cap_block = blocks_by_id.get(source_block_id)
        if drop_cap_block is None:
            continue

        translated = common.sanitize_translated_text(block.get("translatedText") or "")
        if not translated:
            continue

        lead_char, remainder = _split_first_visible_character(translated)
        if not lead_char:
            continue
        drop_cap_block["translatedText"] = lead_char
        block["translatedText"] = remainder


def _prose_heading_signature(text: str) -> str:
    normalized = common.sanitize_translated_text(text)
    return "".join(ch for ch in normalized if ch.isalnum() or "\u3400" <= ch <= "\u9fff")


def _looks_like_redundant_prose_heading_tail(
    previous_block: Dict[str, Any],
    block: Dict[str, Any],
) -> bool:
    if not previous_block or not block:
        return False
    if int(previous_block.get("page") or 0) != int(block.get("page") or 0):
        return False
    if not bool(previous_block.get("_proseHeadingSequence")) or not bool(block.get("_proseHeadingSequence")):
        return False
    if not bool(previous_block.get("_demotedFromHeading")) or not bool(block.get("_demotedFromHeading")):
        return False

    prev_text = common.sanitize_translated_text(previous_block.get("translatedText") or "")
    text = common.sanitize_translated_text(block.get("translatedText") or "")
    if not prev_text or not text:
        return False

    prev_sig = _prose_heading_signature(prev_text)
    sig = _prose_heading_signature(text)
    if len(prev_sig) < 10 or len(sig) < 10:
        return False

    if sig in prev_sig:
        return True
    ratio = SequenceMatcher(None, prev_sig, sig).ratio()
    if ratio < 0.82:
        return False

    prev_bbox = previous_block.get("bbox") or [0, 0, 0, 0]
    bbox = block.get("bbox") or [0, 0, 0, 0]
    if len(prev_bbox) != 4 or len(bbox) != 4:
        return False
    y_gap = float(bbox[1]) - float(prev_bbox[1])
    return y_gap >= -2.0


def _suppress_redundant_prose_heading_tails(blocks: List[Dict[str, Any]]) -> None:
    ordered = sorted(
        blocks,
        key=lambda block: (
            int(block.get("page") or 0),
            float((block.get("bbox") or [0, 0, 0, 0])[1]),
            float((block.get("bbox") or [0, 0, 0, 0])[0]),
        ),
    )
    previous_prose_heading = None
    for block in ordered:
        if _looks_like_redundant_prose_heading_tail(previous_prose_heading, block):
            block["_suppressedRedundantProseHeadingTail"] = True
            block["translatedText"] = ""
        if bool(block.get("_proseHeadingSequence")) and bool(block.get("_demotedFromHeading")):
            previous_prose_heading = block
        else:
            previous_prose_heading = None


def _collect_top_band_text_regions(source_page) -> List[List[float]]:
    regions: List[List[float]] = []
    page_height = max(float(source_page.rect.height), 1.0)
    header_band = page_height * 0.16
    try:
        raw = source_page.get_text("rawdict")
    except Exception:
        return regions

    for block in raw.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            bbox = line.get("bbox") or []
            if len(bbox) != 4:
                continue
            try:
                x0, y0, x1, y1 = [float(v) for v in bbox]
            except Exception:
                continue
            if y1 > header_band:
                continue
            line_text = common.normalize_text(
                "".join(
                    "".join(ch.get("c", "") for ch in span.get("chars", []))
                    for span in (line.get("spans", []) or [])
                )
            )
            if not line_text:
                continue
            regions.append([x0, y0, x1, y1])
    return regions


def _rects_overlap(a, b, margin: float = 0.0) -> bool:
    ax0, ay0, ax1, ay1 = [float(v) for v in a]
    bx0, by0, bx1, by1 = [float(v) for v in b]
    return not (
        ax1 + margin <= bx0
        or bx1 + margin <= ax0
        or ay1 + margin <= by0
        or by1 + margin <= ay0
    )


def _find_brand_rect(page, source_page, logo_width: float, logo_height: float):
    page_width = float(page.rect.width)
    page_height = float(page.rect.height)
    margin_x = max(page_width * 0.03, 22.0)
    margin_y = max(page_height * 0.02, 16.0)
    header_band = page_height * 0.16
    occupied = _collect_top_band_text_regions(source_page)

    target_width = min(max(page_width * 0.135, 78.0), 124.0)
    aspect_ratio = max(logo_width / max(logo_height, 1.0), 0.25)
    target_height = target_width / aspect_ratio
    if target_height > header_band * 0.72:
        target_height = header_band * 0.72
        target_width = target_height * aspect_ratio

    x_candidates = [
        page_width - margin_x - target_width,
        page_width - margin_x - target_width - 28.0,
        page_width - margin_x - target_width - 64.0,
        max(page_width * 0.52, page_width - margin_x - target_width - 112.0),
    ]
    y_candidates = [
        margin_y,
        margin_y + target_height + 6.0,
        margin_y + (target_height + 6.0) * 2.0,
    ]

    for y0 in y_candidates:
        if y0 + target_height > header_band:
            continue
        for x0 in x_candidates:
            x0 = max(x0, margin_x)
            rect = page.rect.__class__(
                x0,
                y0,
                min(x0 + target_width, page_width - margin_x),
                y0 + target_height,
            )
            if any(_rects_overlap(rect, region, margin=2.0) for region in occupied):
                continue
            return rect

    return page.rect.__class__(
        max(page_width - margin_x - target_width, margin_x),
        margin_y,
        min(page_width - margin_x, page_width - 4.0),
        margin_y + target_height,
    )


def _write_brand_logo(page, source_page, fitz) -> None:
    if not BRAND_LOGO_PATH.exists():
        return
    try:
        pixmap = fitz.Pixmap(str(BRAND_LOGO_PATH))
    except Exception:
        return
    rect = _find_brand_rect(page, source_page, float(pixmap.width), float(pixmap.height))
    try:
        page.insert_image(rect, filename=str(BRAND_LOGO_PATH), overlay=True, keep_proportion=True)
    except Exception:
        return
    try:
        page.insert_link(
            {
                "kind": fitz.LINK_URI,
                "from": rect,
                "uri": BRAND_LABEL_URL,
            }
        )
    except Exception:
        pass


def block_is_uncertain(block: Dict[str, Any]) -> bool:
    if str(block.get("preserveReason") or "") == "translation_meta_note":
        return True
    if is_translation_meta_note(str(block.get("translationMetaNote") or "")):
        return True
    if block.get("preserveOriginal"):
        return False
    if str(block.get("doclingLabel") or "") == "picture":
        return True
    if str(block.get("doclingLabel") or "") == "table":
        return True
    if str(block.get("blockType") or "") == "table_body":
        return True
    translated = common.sanitize_translated_text(block.get("translatedText") or "")
    if not translated:
        return True
    bbox = block.get("bbox") or []
    return len(bbox) != 4


def is_reference_block(block: Dict[str, Any]) -> bool:
    block_type = str(block.get("blockType") or "").lower()
    docling_label = str(block.get("doclingLabel") or "").lower()
    preserve_reason = str(block.get("preserveReason") or "").lower()
    text = str(block.get("text") or "").strip()
    return (
        block_type in {"reference_block", "reference", "bibliography"}
        or docling_label == "reference"
        or preserve_reason in {"reference_block", "reference_section"}
        or re.match(r"^\[\d+\]\s+", text) is not None
    )


def is_compact_metadata_preserve_block(block: Dict[str, Any]) -> bool:
    block_type = str(block.get("blockType") or "")
    if block_type not in {"metadata", "page_header", "page_footer"}:
        return False
    if is_short_byline_metadata_block(block):
        return True
    bbox = block.get("bbox") or []
    if len(bbox) != 4:
        return False
    height = max(float(bbox[3]) - float(bbox[1]), 0.0)
    text = common.normalize_text(str(block.get("text") or ""))
    translated = common.normalize_text(str(block.get("translatedText") or ""))
    if not text or not translated:
        return False
    line_count = len(block.get("layoutLines") or [])
    has_affiliation_markers = bool(
        re.search(r"\b(?:UMD|UVA|WUSTL|UNC|Google|Meta)\b", text)
        or re.search(r"(大学|谷歌|Meta)", translated)
    )
    return (
        line_count <= 1
        and height <= 12.5
        and len(translated) > len(text)
        and has_affiliation_markers
    )


def is_code_preserve_block(block: Dict[str, Any]) -> bool:
    docling_label = str(block.get("doclingLabel") or "").lower()
    block_type = str(block.get("blockType") or "").lower()
    return docling_label == "code" or block_type in {"code", "formula_display"}


def resolve_block_action(block: Dict[str, Any]) -> str:
    render_policy = str(rendering.resolve_render_policy(block) or "")
    if render_policy == "preserve_visual":
        block["renderPolicy"] = render_policy
        return "preserve"
    if block.get("preserveOriginal"):
        return "preserve"
    if str(block.get("blockType") or "").lower() in {"formula_display", "table_header", "table_body"}:
        return "preserve"
    if is_reference_block(block):
        return "preserve"
    if is_code_preserve_block(block):
        return "preserve"
    if is_compact_metadata_preserve_block(block):
        return "preserve"
    if block_is_uncertain(block):
        return "review"
    return "replace"


def _group_blocks_by_page(blocks: List[Dict[str, Any]]) -> Dict[int, List[Dict[str, Any]]]:
    grouped: Dict[int, List[Dict[str, Any]]] = {}
    for block in blocks:
        page_number = max(int(block.get("page", 1)) - 1, 0)
        grouped.setdefault(page_number, []).append(block)
    return grouped


def _expand_rect(rect, page_rect, margin: float):
    x0 = max(float(page_rect.x0), float(rect.x0) - margin)
    y0 = max(float(page_rect.y0), float(rect.y0) - margin)
    x1 = min(float(page_rect.x1), float(rect.x1) + margin)
    y1 = min(float(page_rect.y1), float(rect.y1) + margin)
    return page_rect.__class__(x0, y0, x1, y1)


def _collect_text_item_rects(block: Dict[str, Any], fitz) -> Tuple[List[Any], bool]:
    rects: List[Any] = []
    used_bbox_fallback = False
    page_rect = fitz.Rect(
        0.0,
        0.0,
        max(float(block.get("pageWidth") or 0.0), 1.0),
        max(float(block.get("pageHeight") or 0.0), 1.0),
    )

    for line in block.get("layoutLines") or []:
        line_rects = []
        for item in line.get("items", []) or []:
            if item.get("type") != "text":
                continue
            bbox = item.get("bbox") or []
            if len(bbox) != 4:
                continue
            rect = fitz.Rect(*bbox)
            if rect.is_empty or rect.is_infinite:
                continue
            line_rects.append(_expand_rect(rect, page_rect, 0.9))
        if line_rects:
            rects.extend(line_rects)
            continue
        line_bbox = line.get("bbox") or []
        if len(line_bbox) == 4:
            rect = fitz.Rect(*line_bbox)
            if not rect.is_empty and not rect.is_infinite:
                rects.append(_expand_rect(rect, page_rect, 0.9))

    if rects:
        return rects, used_bbox_fallback

    bbox = block.get("bbox") or []
    if len(bbox) == 4:
        rect = fitz.Rect(*bbox)
        if not rect.is_empty and not rect.is_infinite:
            used_bbox_fallback = True
            return [_expand_rect(rect, page_rect, 1.2)], used_bbox_fallback
    return [], used_bbox_fallback


def build_page_erase_plan(page_blocks: List[Dict[str, Any]], fitz) -> Tuple[List[Any], List[Dict[str, Any]]]:
    erase_rects: List[Any] = []
    warnings: List[Dict[str, Any]] = []
    for block in page_blocks:
        action = resolve_block_action(block)
        block["action"] = action
        if action != "replace":
            continue
        rects, used_bbox_fallback = _collect_text_item_rects(block, fitz)
        erase_rects.extend(rects)
        if used_bbox_fallback:
            warnings.append(
                {
                    "type": "bbox_fallback",
                    "page": int(block.get("page") or 0),
                    "blockId": block.get("id"),
                }
            )
    return erase_rects, warnings


def remove_source_text_in_regions(page, erase_rects: List[Any], fitz) -> int:
    annotation_count = 0
    for rect in erase_rects:
        page.add_redact_annot(rect, fill=False, cross_out=False)
        annotation_count += 1
    if annotation_count > 0:
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )
    return annotation_count


def fill_pdf_preserving_graphics(
    input_pdf: str,
    translated_json: str,
    output_pdf: str,
) -> None:
    fitz = common.require_fitz()
    overall_started = time.perf_counter()
    final_output_pdf = output_pdf
    print(
        f"PDF fill start: input={input_pdf} translated_json={translated_json} output={output_pdf}",
        flush=True,
    )

    payload = json.loads(Path(translated_json).read_text(encoding="utf-8"))
    blocks = list(payload.get("blocks", []))
    _apply_drop_cap_translation_splits(blocks)
    _suppress_redundant_prose_heading_tails(blocks)
    blocks_by_page = _group_blocks_by_page(blocks)

    written = 0
    preserved = 0
    review = 0
    failed = 0

    output_path = Path(output_pdf)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"PDF fill: opening source pdf {input_pdf}", flush=True)
    output_doc = fitz.open(input_pdf)
    print(f"PDF fill: source pdf opened pages={len(output_doc)}", flush=True)

    try:
        total_pages = len(output_doc)
        print(f"PDF fill: entering page loop total_pages={total_pages}", flush=True)
        for page_index in range(total_pages):
            output_page = output_doc[page_index]
            page_blocks = blocks_by_page.get(page_index, [])
            page_started = time.perf_counter()
            print(
                f"PDF fill: page {page_index + 1}/{total_pages} start",
                flush=True,
            )

            erase_rects, erase_warnings = build_page_erase_plan(page_blocks, fitz)
            print(
                f"PDF fill: page {page_index + 1}/{total_pages} erase plan "
                f"rects={len(erase_rects)} warnings={len(erase_warnings)}",
                flush=True,
            )
            print(
                f"PDF fill: page {page_index + 1}/{total_pages} redaction start",
                flush=True,
            )
            redaction_count = remove_source_text_in_regions(output_page, erase_rects, fitz)
            print(
                f"PDF fill: page {page_index + 1}/{total_pages} redaction done "
                f"annotations={redaction_count}",
                flush=True,
            )

            for warning in erase_warnings:
                print(
                    f"WARN: erase mask fallback for block {warning.get('blockId')} on page {warning.get('page')}",
                    flush=True,
                )

            for block in page_blocks:
                action = resolve_block_action(block)
                block["action"] = action
                print(
                    f"PDF fill: page {page_index + 1}/{total_pages} block {block.get('id')} start "
                    f"(action={action} role={block.get('role')})",
                    flush=True,
                )
                if action == "preserve":
                    preserved += 1
                    continue
                if action == "review":
                    review += 1
                    print(
                        f"WARN: block {block.get('id')} on page {block.get('page')} marked review; "
                        f"keeping source background only",
                        flush=True,
                    )
                    continue

                try:
                    result = rendering.write_translated_block(
                        output_page,
                        block,
                        fitz,
                        debug_visuals=False,
                    )
                except Exception as exc:
                    raise RuntimeError(
                        "write_translated_block raised an exception: "
                        f"block={block.get('id')} "
                        f"page={page_index + 1} "
                        f"bbox={block.get('bbox')} "
                        f"blockType={block.get('blockType')} "
                        f"doclingLabel={block.get('doclingLabel')} "
                        f"sourceLength={len(str(block.get('text') or ''))} "
                        f"translatedLength={len(str(block.get('translatedText') or ''))}"
                    ) from exc
                if result:
                    written += 1
                elif result is None:
                    review += 1
                    block["action"] = "review"
                    print(
                        f"WARN: block {block.get('id')} on page {block.get('page')} produced no renderable text; "
                        f"downgrading to review",
                        flush=True,
                    )
                else:
                    failed += 1
                    raise RuntimeError(
                        "write_translated_block could not fit text: "
                        f"block={block.get('id')} "
                        f"page={page_index + 1} "
                        f"bbox={block.get('bbox')} "
                        f"blockType={block.get('blockType')} "
                        f"doclingLabel={block.get('doclingLabel')} "
                        f"sourceLength={len(str(block.get('text') or ''))} "
                        f"translatedLength={len(str(block.get('translatedText') or ''))}"
                    )

            if page_index == 0:
                _write_brand_logo(output_page, output_page, fitz)

            print(
                f"PDF fill: page {page_index + 1}/{total_pages} done "
                f"(written={written} preserved={preserved} review={review} failed={failed} redactions={redaction_count}) "
                f"elapsed={time.perf_counter() - page_started:.2f}s",
                flush=True,
            )

        subset_started = time.perf_counter()
        print("PDF fill: subset_fonts start", flush=True)
        output_doc.subset_fonts()
        print(
            f"PDF fill: subset_fonts done elapsed={time.perf_counter() - subset_started:.2f}s",
            flush=True,
        )

        save_started = time.perf_counter()
        print("PDF fill: save start", flush=True)
        final_output_pdf = output_pdf
        try:
            output_doc.save(
                final_output_pdf,
                garbage=4,
                deflate=True,
                deflate_images=True,
                deflate_fonts=True,
                use_objstms=1,
            )
        except Exception as exc:
            message = str(exc or "")
            if "cannot remove file" not in message.lower() and "permission denied" not in message.lower():
                raise
            fallback_output_pdf = _fallback_output_path(output_pdf)
            print(
                f"WARN: target output is locked, saving to fallback path: {fallback_output_pdf}",
                flush=True,
            )
            final_output_pdf = fallback_output_pdf
            output_doc.save(
                final_output_pdf,
                garbage=4,
                deflate=True,
                deflate_images=True,
                deflate_fonts=True,
                use_objstms=1,
            )
        print(
            f"PDF fill: save done path={final_output_pdf} elapsed={time.perf_counter() - save_started:.2f}s",
            flush=True,
        )
    finally:
        output_doc.close()

    print(
        f"Filled PDF with in-place text replacement: {final_output_pdf} "
        f"(written={written}, preserved={preserved}, review={review}, failed={failed}) "
        f"elapsed={time.perf_counter() - overall_started:.2f}s",
        flush=True,
    )
