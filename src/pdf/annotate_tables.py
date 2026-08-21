#!/usr/bin/env python3
"""Draw detected structured regions onto the original PDF."""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import fitz

from app.pdf_page_selection import parse_pages
from detect_tables import detect_tables
from services.pdf_services import extract_pdf_blocks


def _load_detection(
    input_path: Path,
    detection_json: Optional[Path],
    pages: Optional[List[int]],
) -> Tuple[Dict[str, Any], Optional[Path]]:
    if detection_json is not None:
        return json.loads(detection_json.read_text(encoding="utf-8")), None

    if input_path.suffix.lower() == ".json":
        data = json.loads(input_path.read_text(encoding="utf-8"))
        return detect_tables(data), None

    temp = tempfile.NamedTemporaryFile(prefix="wasabi_table_annotate_", suffix=".json", delete=False)
    temp_path = Path(temp.name)
    temp.close()
    extract_pdf_blocks(str(input_path), str(temp_path), pages)
    data = json.loads(temp_path.read_text(encoding="utf-8"))
    return detect_tables(data), temp_path


def _page_structure_map(detection: Dict[str, Any]) -> Dict[int, List[Dict[str, Any]]]:
    mapping: Dict[int, List[Dict[str, Any]]] = {}
    for page in detection.get("pages") or []:
        page_no = int(page.get("page") or 0)
        structures = list(page.get("structures") or page.get("tables") or [])
        if structures:
            mapping[page_no] = structures
    return mapping


def _draw_label(page: fitz.Page, rect: fitz.Rect, label: str) -> None:
    label_height = 12
    label_rect = fitz.Rect(rect.x0, max(0, rect.y0 - label_height - 2), min(page.rect.x1, rect.x0 + 120), max(0, rect.y0 - 2))
    if label_rect.width <= 1 or label_rect.height <= 1:
        return
    page.insert_textbox(
        label_rect,
        label,
        fontsize=8,
        fontname="helv",
        color=(0.65, 0.0, 0.0),
        align=fitz.TEXT_ALIGN_LEFT,
        overlay=True,
    )


def _draw_box(page: fitz.Page, bbox: List[float], color: tuple[float, float, float], width: float) -> Optional[fitz.Rect]:
    if len(bbox) != 4:
        return None
    rect = fitz.Rect(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
    page.draw_rect(rect, color=color, width=width, overlay=True)
    return rect


def annotate_pdf(
    input_pdf: Path,
    output_pdf: Path,
    detection: Dict[str, Any],
    show_display_bbox: bool = False,
) -> int:
    doc = fitz.open(str(input_pdf))
    page_map = _page_structure_map(detection)
    count = 0

    for page_no, structures in page_map.items():
        page_index = page_no - 1
        if page_index < 0 or page_index >= doc.page_count:
            continue
        page = doc[page_index]
        for structure in structures:
            body_bbox = structure.get("bbox") or []
            display_bbox = structure.get("displayBBox") or body_bbox
            display_rect = None
            if show_display_bbox and display_bbox != body_bbox:
                display_rect = _draw_box(page, display_bbox, color=(0.95, 0.45, 0.0), width=1.0)
            body_rect = _draw_box(page, body_bbox, color=(0.85, 0.0, 0.0), width=1.5)
            rect = body_rect or display_rect
            if rect is None:
                continue
            _draw_label(page, rect, str(structure.get("id") or f"p{page_no}_structure"))
            count += 1

    doc.save(str(output_pdf))
    doc.close()
    return count


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Annotate detected structured regions on the original PDF")
    parser.add_argument("input_pdf", help="Original source PDF")
    parser.add_argument("output_pdf", help="Annotated output PDF")
    parser.add_argument("--detection-json", default=None, help="Optional precomputed table detection JSON")
    parser.add_argument("--pages", type=parse_pages, default=None, help="Optional page selection when detecting from PDF")
    parser.add_argument(
        "--show-display-bbox",
        action="store_true",
        help="Also draw displayBBox when it differs from bbox",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    input_pdf = Path(args.input_pdf)
    output_pdf = Path(args.output_pdf)
    detection_json = Path(args.detection_json) if args.detection_json else None

    detection, temp_extract_json = _load_detection(input_pdf, detection_json, args.pages)
    try:
        count = annotate_pdf(
            input_pdf,
            output_pdf,
            detection,
            show_display_bbox=bool(args.show_display_bbox),
        )
    finally:
        if temp_extract_json is not None:
            temp_extract_json.unlink(missing_ok=True)

    print(f"Annotated structures: {count} -> {output_pdf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
