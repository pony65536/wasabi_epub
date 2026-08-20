from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

from domain import common
from services.pdf_fill_impl import (
    BACKGROUND_RENDER_ZOOM,
    _apply_drop_cap_translation_splits,
    _group_blocks_by_page,
    _suppress_redundant_prose_heading_tails,
    build_page_erase_plan,
    resolve_block_action,
)


def _compact_text(value: str) -> str:
    return "".join(ch for ch in str(value or "") if not ch.isspace()).strip()


def _match_needle(value: str, *, minimum: int = 12, maximum: int = 80) -> str:
    compact = _compact_text(value)
    if not compact:
        return ""
    if len(compact) <= minimum:
        return compact
    return compact[: min(maximum, len(compact))]


def _count_occurrences(haystack: str, needle: str) -> int:
    if not haystack or not needle:
        return 0
    count = 0
    start = 0
    while True:
        index = haystack.find(needle, start)
        if index < 0:
            return count
        count += 1
        start = index + len(needle)


def _validation_issue(issue_type: str, **fields: Any) -> Dict[str, Any]:
    return {"type": issue_type, **fields}


def _mask_output_dir(validation_json: str) -> Path:
    path = Path(validation_json)
    return path.with_name(f"{path.stem}_assets")


def _save_mask_preview(mask_rects, page_rect, path: Path, fitz) -> None:
    mask_doc = fitz.open()
    try:
        mask_page = mask_doc.new_page(width=float(page_rect.width), height=float(page_rect.height))
        mask_page.draw_rect(mask_page.rect, color=(0, 0, 0), fill=(0, 0, 0), width=0)
        for rect in mask_rects:
            mask_page.draw_rect(rect, color=(1, 1, 1), fill=(1, 1, 1), width=0)
        pix = mask_page.get_pixmap(matrix=fitz.Matrix(BACKGROUND_RENDER_ZOOM, BACKGROUND_RENDER_ZOOM), alpha=False)
        path.parent.mkdir(parents=True, exist_ok=True)
        pix.save(path)
    finally:
        mask_doc.close()


def _page_compact_text(page) -> str:
    return _compact_text(page.get_text("text"))


def validate_text_layer(output_doc, blocks_by_page: Dict[int, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    for page_index in range(len(output_doc)):
        page_text = _page_compact_text(output_doc[page_index])
        for block in blocks_by_page.get(page_index, []):
            action = resolve_block_action(block)
            expected_action = str(block.get("action") or action)
            if expected_action != action:
                issues.append(
                    _validation_issue(
                        "action_mismatch",
                        page=page_index + 1,
                        blockId=block.get("id"),
                        storedAction=expected_action,
                        resolvedAction=action,
                    )
                )

            if action == "review":
                issues.append(
                    _validation_issue(
                        "review_block",
                        page=page_index + 1,
                        blockId=block.get("id"),
                    )
                )
                continue
            if action != "replace":
                continue

            source_probe = _match_needle(block.get("text") or "")
            if source_probe and source_probe in page_text:
                issues.append(
                    _validation_issue(
                        "source_text_residue",
                        page=page_index + 1,
                        blockId=block.get("id"),
                        probe=source_probe[:32],
                    )
                )

            translated_probe = _match_needle(block.get("translatedText") or "")
            if not translated_probe:
                issues.append(
                    _validation_issue(
                        "translation_missing",
                        page=page_index + 1,
                        blockId=block.get("id"),
                    )
                )
                continue

            occurrence_count = _count_occurrences(page_text, translated_probe)
            if occurrence_count <= 0:
                issues.append(
                    _validation_issue(
                        "translation_missing",
                        page=page_index + 1,
                        blockId=block.get("id"),
                        probe=translated_probe[:32],
                    )
                )
            elif occurrence_count > 1:
                issues.append(
                    _validation_issue(
                        "translation_duplicate",
                        page=page_index + 1,
                        blockId=block.get("id"),
                        occurrences=occurrence_count,
                        probe=translated_probe[:32],
                    )
                )

        try:
            for trace in output_doc[page_index].get_texttrace():
                trace_type = trace.get("type")
                opacity = float(trace.get("opacity", 1.0) or 0.0)
                if trace_type == 3:
                    issues.append(
                        _validation_issue(
                            "hidden_text_trace",
                            page=page_index + 1,
                        )
                    )
                    break
                if opacity <= 0.001:
                    issues.append(
                        _validation_issue(
                            "transparent_text_trace",
                            page=page_index + 1,
                        )
                    )
                    break
        except Exception as exc:
            issues.append(
                _validation_issue(
                    "texttrace_unavailable",
                    page=page_index + 1,
                    error=str(exc),
                )
            )
    return issues


def validate_erase_masks(
    input_doc,
    output_doc,
    blocks_by_page: Dict[int, List[Dict[str, Any]]],
    validation_json: str,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    fitz = common.require_fitz()
    issues: List[Dict[str, Any]] = []
    pages: List[Dict[str, Any]] = []
    assets_dir = _mask_output_dir(validation_json)

    for page_index in range(len(output_doc)):
        page_blocks = blocks_by_page.get(page_index, [])
        mask_rects, warnings = build_page_erase_plan(page_blocks, fitz)
        source_page = input_doc[page_index]
        output_page = output_doc[page_index]
        page_record: Dict[str, Any] = {
            "page": page_index + 1,
            "eraseRectCount": len(mask_rects),
            "warnings": warnings,
        }
        if not mask_rects:
            pages.append(page_record)
            continue

        mask_path = assets_dir / f"page_{page_index + 1:04d}_mask.png"
        _save_mask_preview(mask_rects, source_page.rect, mask_path, fitz)
        page_record["maskPath"] = str(mask_path)

        source_pix = source_page.get_pixmap(matrix=fitz.Matrix(BACKGROUND_RENDER_ZOOM, BACKGROUND_RENDER_ZOOM), alpha=False)
        output_pix = output_page.get_pixmap(matrix=fitz.Matrix(BACKGROUND_RENDER_ZOOM, BACKGROUND_RENDER_ZOOM), alpha=False)
        mask_pix = fitz.Pixmap(str(mask_path))

        source_samples = memoryview(source_pix.samples)
        output_samples = memoryview(output_pix.samples)
        mask_samples = memoryview(mask_pix.samples)
        source_n = int(source_pix.n)
        output_n = int(output_pix.n)
        mask_n = int(mask_pix.n)

        mask_pixels = 0
        changed_pixels = 0
        diff_threshold = 24
        for pixel_index in range(source_pix.width * source_pix.height):
            if mask_samples[pixel_index * mask_n] < 128:
                continue
            mask_pixels += 1
            source_offset = pixel_index * source_n
            output_offset = pixel_index * output_n
            if any(
                abs(int(source_samples[source_offset + channel]) - int(output_samples[output_offset + channel])) >= diff_threshold
                for channel in range(min(3, source_n, output_n))
            ):
                changed_pixels += 1

        changed_ratio = changed_pixels / max(mask_pixels, 1)
        page_record["maskPixels"] = mask_pixels
        page_record["changedPixels"] = changed_pixels
        page_record["changedRatio"] = round(changed_ratio, 4)

        if changed_ratio < 0.05:
            crop_rect = mask_rects[0]
            for rect in mask_rects[1:]:
                crop_rect |= rect
            crop_margin = 6.0
            crop_rect = fitz.Rect(
                max(source_page.rect.x0, crop_rect.x0 - crop_margin),
                max(source_page.rect.y0, crop_rect.y0 - crop_margin),
                min(source_page.rect.x1, crop_rect.x1 + crop_margin),
                min(source_page.rect.y1, crop_rect.y1 + crop_margin),
            )
            source_crop_path = assets_dir / f"page_{page_index + 1:04d}_source_crop.png"
            output_crop_path = assets_dir / f"page_{page_index + 1:04d}_output_crop.png"
            source_page.get_pixmap(
                matrix=fitz.Matrix(BACKGROUND_RENDER_ZOOM, BACKGROUND_RENDER_ZOOM),
                clip=crop_rect,
                alpha=False,
            ).save(source_crop_path)
            output_page.get_pixmap(
                matrix=fitz.Matrix(BACKGROUND_RENDER_ZOOM, BACKGROUND_RENDER_ZOOM),
                clip=crop_rect,
                alpha=False,
            ).save(output_crop_path)
            page_record["sourceCropPath"] = str(source_crop_path)
            page_record["outputCropPath"] = str(output_crop_path)
            issues.append(
                _validation_issue(
                    "erase_change_too_small",
                    page=page_index + 1,
                    changedRatio=round(changed_ratio, 4),
                    maskPath=str(mask_path),
                    sourceCropPath=str(source_crop_path),
                    outputCropPath=str(output_crop_path),
                )
            )

        for warning in warnings:
            issues.append(_validation_issue("erase_mask_warning", **warning))
        pages.append(page_record)
    return issues, pages


def write_validation_report(validation_json: str, report: Dict[str, Any]) -> Dict[str, Any]:
    path = Path(validation_json)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def validate_translated_pdf(
    input_pdf: str,
    translated_json: str,
    output_pdf: str,
    validation_json: str,
) -> Dict[str, Any]:
    fitz = common.require_fitz()
    payload = json.loads(Path(translated_json).read_text(encoding="utf-8"))
    blocks = list(payload.get("blocks", []))
    _apply_drop_cap_translation_splits(blocks)
    _suppress_redundant_prose_heading_tails(blocks)
    blocks_by_page = _group_blocks_by_page(blocks)

    input_doc = fitz.open(input_pdf)
    output_doc = fitz.open(output_pdf)
    try:
        text_issues = validate_text_layer(output_doc, blocks_by_page)
        visual_issues, page_reports = validate_erase_masks(
            input_doc,
            output_doc,
            blocks_by_page,
            validation_json,
        )
    finally:
        input_doc.close()
        output_doc.close()

    issues = text_issues + visual_issues
    status = "ok" if not issues else "needs_review"
    report = {
        "status": status,
        "inputPdf": input_pdf,
        "outputPdf": output_pdf,
        "translatedJson": translated_json,
        "issues": issues,
        "pages": page_reports,
    }
    return write_validation_report(validation_json, report)
