from __future__ import annotations

import json
import tempfile
import time
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List

from domain import common, core, preservation, rendering
from services.pdf_strip_impl import strip_text_from_pdf


BRAND_LABEL_URL = "https://github.com/pony65536/wasabi_epub"
BRAND_LOGO_PATH = Path(__file__).resolve().parents[1] / "app" / "assets" / "wasabi.png"


def _to_pdf_coordinate_regions(
    regions_by_page: List[List[List[float]]],
    pages_blocks: List[List[Dict[str, Any]]],
) -> List[List[List[float]]]:
    pdf_regions_by_page: List[List[List[float]]] = []
    for page_index, regions in enumerate(regions_by_page):
        page_blocks = pages_blocks[page_index] if page_index < len(pages_blocks) else []
        page_height = max(
            float((page_blocks[0].get("pageHeight") if page_blocks else 0.0) or 0.0),
            1.0,
        )
        converted: List[List[float]] = []
        for region in regions:
            if len(region) != 4:
                continue
            x0, y0, x1, y1 = [float(v) for v in region]
            converted.append([x0, page_height - y1, x1, page_height - y0])
        pdf_regions_by_page.append(converted)
    return pdf_regions_by_page


def _fitz_regions_map_to_pdf_coordinate_regions(
    regions_by_page: Dict[int, List[List[float]]],
    source_doc,
) -> List[List[List[float]]]:
    pdf_regions_by_page: List[List[List[float]]] = []
    for page_index in range(len(source_doc)):
        page_height = max(float(source_doc[page_index].rect.height), 1.0)
        converted: List[List[float]] = []
        for region in regions_by_page.get(page_index, []):
            if len(region) != 4:
                continue
            x0, y0, x1, y1 = [float(v) for v in region]
            converted.append([x0, page_height - y1, x1, page_height - y0])
        pdf_regions_by_page.append(converted)
    return pdf_regions_by_page


def _preserved_text_signatures_by_page(
    pages_blocks: List[List[Dict[str, Any]]],
) -> List[set[str]]:
    import re

    def signature(value: str) -> str:
        return re.sub(r"[^A-Za-z0-9]+", "", str(value or "").upper()).strip()

    signatures_by_page: List[set[str]] = []
    for page_blocks in pages_blocks:
        signatures: set[str] = set()
        for block in page_blocks:
            if str(block.get("preserveReason") or "") != "peripheral_repeat":
                continue
            normalized = signature(str(block.get("text") or ""))
            if normalized:
                signatures.add(normalized)
        signatures_by_page.append(signatures)
    return signatures_by_page


def _fallback_output_path(output_pdf: str) -> str:
    target = Path(output_pdf)
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    return str(target.with_name(f"{target.stem}_{timestamp}{target.suffix}"))


def _merge_pdf_region_lists(
    first: List[List[List[float]]],
    second: List[List[List[float]]],
) -> List[List[List[float]]]:
    total = max(len(first), len(second))
    merged: List[List[List[float]]] = []
    for page_index in range(total):
        page_regions: List[List[float]] = []
        if page_index < len(first):
            page_regions.extend(first[page_index])
        if page_index < len(second):
            page_regions.extend(second[page_index])
        merged.append(page_regions)
    return merged


def _build_preserved_decorative_picture_regions_by_page(
    pages_blocks: List[List[Dict[str, Any]]],
) -> List[List[List[float]]]:
    regions_by_page: List[List[List[float]]] = []
    for page_blocks in pages_blocks:
        page_regions: List[List[float]] = []
        for block in page_blocks:
            if not block.get("preserveOriginal"):
                continue
            if str(block.get("preserveReason") or "") != "picture_region":
                continue
            bbox = block.get("bbox") or []
            if len(bbox) != 4:
                continue
            page_width = max(float(block.get("pageWidth") or 1.0), 1.0)
            page_height = max(float(block.get("pageHeight") or 1.0), 1.0)
            x0, y0, x1, y1 = [float(v) for v in bbox]
            width = max(x1 - x0, 0.0)
            height = max(y1 - y0, 0.0)
            area_ratio = (width * height) / max(page_width * page_height, 1.0)
            hits_top_band = y1 <= page_height * 0.08
            hits_bottom_band = y0 >= page_height * 0.92
            hits_side_band = x1 <= page_width * 0.18 or x0 >= page_width * 0.82
            is_small_decorative = area_ratio <= 0.02
            if (hits_top_band or hits_bottom_band or hits_side_band) and is_small_decorative:
                page_regions.append(core.bbox_with_margin([x0, y0, x1, y1], 3.0))
        regions_by_page.append(page_regions)
    return regions_by_page


def _bbox_hits_any_region(
    bbox: List[float] | tuple[float, float, float, float],
    regions: List[List[float]],
    *,
    min_overlap_ratio: float = 0.6,
) -> bool:
    if len(bbox) != 4:
        return False
    for region in regions:
        if len(region) != 4:
            continue
        if common.bbox_overlap_ratio(list(bbox), region) >= min_overlap_ratio:
            return True
    return False


def _page_has_preserved_text_regions(
    page_index: int,
    preserved_text_regions_by_page: List[List[List[float]]],
) -> bool:
    return (
        0 <= page_index < len(preserved_text_regions_by_page)
        and bool(preserved_text_regions_by_page[page_index])
    )


def _preserve_mode_for_block(
    block: Dict[str, Any],
    decorative_regions_by_page: List[List[List[float]]],
) -> str:
    if not block.get("preserveOriginal"):
        return "pdf"
    if str(block.get("preserveReason") or "") != "picture_region":
        return "pdf"
    page_index = max(int(block.get("page", 1)) - 1, 0)
    decorative_regions = (
        decorative_regions_by_page[page_index]
        if 0 <= page_index < len(decorative_regions_by_page)
        else []
    )
    if _bbox_hits_any_region(block.get("bbox") or [], decorative_regions):
        return "pdf"
    return "image"


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
    overall_started = time.perf_counter()
    final_output_pdf = output_pdf
    print(
        f"PDF fill start: input={input_pdf} translated_json={translated_json} output={output_pdf}",
        flush=True,
    )
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
    pages_blocks = [
        blocks_by_page.get(page_index, [])
        for page_index in range(max(blocks_by_page.keys(), default=-1) + 1)
    ]

    output_path = Path(output_pdf)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=f"wasabi_{output_path.stem}_stripped_",
        suffix=".pdf",
        delete=False,
    ) as temp_file:
        stripped_pdf_path = Path(temp_file.name)

    try:
        strip_started = time.perf_counter()
        print("PDF fill: strip_text_from_pdf start", flush=True)
        source_doc = fitz.open(input_pdf)
        preserved_peripheral_regions_map = preservation.build_preserved_peripheral_regions_by_page(
            pages_blocks
        )
        preserved_peripheral_regions_by_page = [
            preserved_peripheral_regions_map.get(page_index, [])
            for page_index in range(len(pages_blocks))
        ]
        preserved_peripheral_regions_pdf_by_page = _to_pdf_coordinate_regions(
            preserved_peripheral_regions_by_page,
            pages_blocks,
        )
        preserved_decorative_picture_regions_by_page = _build_preserved_decorative_picture_regions_by_page(
            pages_blocks
        )
        preserved_decorative_picture_regions_pdf_by_page = _to_pdf_coordinate_regions(
            preserved_decorative_picture_regions_by_page,
            pages_blocks,
        )
        running_header_regions_by_page = preservation.detect_running_header_label_regions(source_doc)
        running_header_regions_pdf_by_page = _fitz_regions_map_to_pdf_coordinate_regions(
            running_header_regions_by_page,
            source_doc,
        )
        preserved_text_regions_by_page = _merge_pdf_region_lists(
            preserved_peripheral_regions_pdf_by_page,
            preserved_decorative_picture_regions_pdf_by_page,
        )
        preserved_text_regions_by_page = _merge_pdf_region_lists(
            preserved_text_regions_by_page,
            running_header_regions_pdf_by_page,
        )
        preserved_text_signatures_by_page = _preserved_text_signatures_by_page(
            pages_blocks
        )
        strip_stats = strip_text_from_pdf(
            input_pdf,
            str(stripped_pdf_path),
            preserve_risky_text=False,
            preserve_unterminated_text=False,
            preserve_text_regions_by_page=preserved_text_regions_by_page,
            preserve_text_signatures_by_page=preserved_text_signatures_by_page,
        )
        print(
            f"PDF fill: strip_text_from_pdf done pages={strip_stats.pages} "
            f"streams={strip_stats.streams} removed_text_objects={strip_stats.removed_text_objects} "
            f"retained_preserved_region_text_objects={strip_stats.retained_preserved_region_text_objects} "
            f"retained_form_text_objects={strip_stats.retained_form_text_objects} "
            f"elapsed={time.perf_counter() - strip_started:.2f}s",
            flush=True,
        )
        doc = fitz.open(stripped_pdf_path)
        try:
            total_pages = len(doc)
            for page_index, page in enumerate(doc):
                page_started = time.perf_counter()
                overlay_doc = fitz.open()
                overlay_page = overlay_doc.new_page(
                    width=float(page.rect.width),
                    height=float(page.rect.height),
                )
                overlay_has_content = False
                print(
                    f"PDF fill: page {page_index + 1}/{total_pages} start",
                    flush=True,
                )
                if _page_has_preserved_text_regions(page_index, preserved_text_regions_by_page):
                    print(
                        f"PDF fill: page {page_index + 1}/{total_pages} wrap_contents "
                        f"due to preserved text regions",
                        flush=True,
                    )
                    try:
                        page.wrap_contents()
                    except Exception:
                        pass
                else:
                    try:
                        page.clean_contents()
                    except Exception:
                        pass
                for block in blocks_by_page.get(page_index, []):
                    print(
                        f"PDF fill: page {page_index + 1}/{total_pages} block {block.get('id')} start "
                        f"(role={block.get('role')} preserve={bool(block.get('preserveOriginal'))})",
                        flush=True,
                    )
                    if str(block.get("preserveReason") or "") == "peripheral_repeat":
                        preserved += 1
                        print(
                            f"PDF fill: page {page_index + 1}/{total_pages} block {block.get('id')} deferred "
                            f"to peripheral region restore",
                            flush=True,
                        )
                        continue
                    if (
                        block.get("preserveOriginal")
                        and str(block.get("preserveReason") or "") == "picture_region"
                        and _bbox_hits_any_region(
                            block.get("bbox") or [],
                            (
                                running_header_regions_by_page.get(page_index, [])
                                + (
                                    preserved_decorative_picture_regions_by_page[page_index]
                                    if page_index < len(preserved_decorative_picture_regions_by_page)
                                    else []
                                )
                            ),
                        )
                    ):
                        preserved += 1
                        print(
                            f"PDF fill: page {page_index + 1}/{total_pages} block {block.get('id')} deferred "
                            f"to strip-preserved decorative region",
                            flush=True,
                        )
                        continue
                    if block.get("preserveReason") == "translation_meta_note":
                        note_preview = common.normalize_text(block.get("translationMetaNote") or "")[:120]
                        print(
                            f"WARN: preserving source for {block.get('id')} on page {block.get('page')} "
                            f"due to translator meta note: {note_preview!r}",
                            flush=True,
                        )
                    target_page = page if block.get("preserveOriginal") else overlay_page
                    preserve_mode = _preserve_mode_for_block(
                        block,
                        preserved_decorative_picture_regions_by_page,
                    )
                    result = rendering.write_translated_block(
                        target_page,
                        block,
                        fitz,
                        source_doc=source_doc,
                        preserve_mode=preserve_mode,
                        erase_mode="none",
                        debug_visuals=False,
                    )
                    if result is None:
                        print(
                            f"PDF fill: page {page_index + 1}/{total_pages} block {block.get('id')} skipped",
                            flush=True,
                        )
                        continue
                    if result:
                        if not block.get("preserveOriginal"):
                            overlay_has_content = True
                        if block.get("preserveOriginal"):
                            preserved += 1
                        else:
                            written += 1
                        print(
                            f"PDF fill: page {page_index + 1}/{total_pages} block {block.get('id')} done "
                            f"(written={written} preserved={preserved} failed={failed})",
                            flush=True,
                        )
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
                            flush=True,
                        )
                if overlay_has_content:
                    try:
                        page.show_pdf_page(page.rect, overlay_doc, 0, overlay=True)
                    except Exception:
                        failed += 1
                        print(
                            f"WARN: overlay merge failed on page {page_index + 1}",
                            flush=True,
                        )
                if page_index == 0:
                    _write_brand_logo(page, source_doc[page_index], fitz)
                print(
                    f"PDF fill: page {page_index + 1}/{total_pages} done "
                    f"(written={written} preserved={preserved} failed={failed}) "
                    f"elapsed={time.perf_counter() - page_started:.2f}s",
                    flush=True,
                )
                overlay_doc.close()

            subset_started = time.perf_counter()
            print("PDF fill: subset_fonts start", flush=True)
            doc.subset_fonts()
            print(
                f"PDF fill: subset_fonts done elapsed={time.perf_counter() - subset_started:.2f}s",
                flush=True,
            )
            save_started = time.perf_counter()
            print("PDF fill: save start", flush=True)
            final_output_pdf = output_pdf
            try:
                doc.save(
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
                doc.save(
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
            source_doc.close()
            doc.close()
    finally:
        try:
            stripped_pdf_path.unlink(missing_ok=True)
        except Exception:
            pass

    print(
        f"Filled PDF preserving original graphics: {final_output_pdf} "
        f"(written={written}, preserved={preserved}, failed={failed}, "
        f"stripped_pages={strip_stats.pages}, stripped_streams={strip_stats.streams}, "
        f"removed_text_objects={strip_stats.removed_text_objects}, "
        f"retained_risky_text_objects={strip_stats.retained_risky_text_objects}, "
        f"retained_preserved_region_text_objects={strip_stats.retained_preserved_region_text_objects}, "
        f"retained_form_text_objects={strip_stats.retained_form_text_objects}, "
        f"retained_unterminated_text_objects={strip_stats.retained_unterminated_text_objects}, "
        f"forms={strip_stats.forms}) "
        f"elapsed={time.perf_counter() - overall_started:.2f}s",
        flush=True,
    )
