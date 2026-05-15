from __future__ import annotations

import json
import tempfile
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List

from domain import common, preservation, rendering
from services.pdf_strip_impl import strip_text_from_pdf


BRAND_LABEL_URL = "https://github.com/pony65536/wasabi_epub"
BRAND_LOGO_PATH = Path(__file__).resolve().parents[1] / "app" / "assets" / "wasabi.png"


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


def fill_pdf_preserving_graphics(
    input_pdf: str,
    translated_json: str,
    output_pdf: str,
) -> None:
    fitz = common.require_fitz()
    payload = json.loads(Path(translated_json).read_text(encoding="utf-8"))
    _apply_drop_cap_translation_splits(payload.get("blocks", []))
    _suppress_redundant_prose_heading_tails(payload.get("blocks", []))
    written = 0
    failed = 0
    preserved = 0
    blocks_by_page: Dict[int, List[Dict[str, Any]]] = {}
    for block in payload.get("blocks", []):
        page_number = int(block.get("page", 0)) - 1
        blocks_by_page.setdefault(page_number, []).append(block)

    output_path = Path(output_pdf)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=f"wasabi_{output_path.stem}_stripped_",
        suffix=".pdf",
        delete=False,
    ) as temp_file:
        stripped_pdf_path = Path(temp_file.name)

    try:
        strip_stats = strip_text_from_pdf(
            input_pdf,
            str(stripped_pdf_path),
            preserve_risky_text=False,
            preserve_unterminated_text=False,
        )
        doc = fitz.open(stripped_pdf_path)
        source_doc = fitz.open(input_pdf)
        try:
            running_header_regions_by_page = preservation.detect_running_header_label_regions(source_doc)
            for page_index, page in enumerate(doc):
                try:
                    page.clean_contents()
                except Exception:
                    pass
                for block in blocks_by_page.get(page_index, []):
                    if block.get("preserveReason") == "translation_meta_note":
                        note_preview = common.normalize_text(block.get("translationMetaNote") or "")[:120]
                        print(
                            f"WARN: preserving source for {block.get('id')} on page {block.get('page')} "
                            f"due to translator meta note: {note_preview!r}",
                        )
                    result = rendering.write_translated_block(
                        page,
                        block,
                        fitz,
                        source_doc=source_doc,
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
                            else common.sanitize_translated_text(block.get("translatedText") or "")
                        )
                        preview = common.normalize_text(preview_source or "")[:80]
                        print(
                            f"WARN: write failed for {block.get('id')} on page {block.get('page')} "
                            f"bbox={block.get('bbox')} text={preview!r}",
                        )
                rect_type = page.rect.__class__
                for region in running_header_regions_by_page.get(page_index, []):
                    clip = source_doc[page_index].rect & rect_type(*region)
                    if clip.is_empty:
                        continue
                    rendering.insert_source_clip_as_image(
                        page,
                        source_doc,
                        page_index,
                        rect_type(*region),
                        clip,
                        zoom=4.0,
                    )
                if page_index == 0:
                    _write_brand_logo(page, source_doc[page_index], fitz)

            doc.subset_fonts()
            doc.save(
                output_pdf,
                garbage=4,
                deflate=True,
                deflate_images=True,
                deflate_fonts=True,
                use_objstms=1,
            )
        finally:
            source_doc.close()
            doc.close()
    finally:
        try:
            stripped_pdf_path.unlink(missing_ok=True)
        except Exception:
            pass

    print(
        f"Filled PDF preserving original graphics: {output_pdf} "
        f"(written={written}, preserved={preserved}, failed={failed}, "
        f"stripped_pages={strip_stats.pages}, stripped_streams={strip_stats.streams}, "
        f"removed_text_objects={strip_stats.removed_text_objects}, "
        f"retained_risky_text_objects={strip_stats.retained_risky_text_objects}, "
        f"retained_unterminated_text_objects={strip_stats.retained_unterminated_text_objects}, "
        f"forms={strip_stats.forms})"
    )
