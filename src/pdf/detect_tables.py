#!/usr/bin/env python3
"""Standalone PDF table detector for Wasabi."""

from __future__ import annotations

import argparse
import json
import re
import statistics
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import fitz

from app.pdf_page_selection import parse_pages
from domain import common, core


def _bbox(block: Dict[str, Any]) -> Optional[List[float]]:
    bbox = block.get("bbox") or []
    if len(bbox) != 4:
        return None
    return [float(v) for v in bbox]


def _bbox_width(bbox: List[float]) -> float:
    return max(float(bbox[2]) - float(bbox[0]), 0.0)


def _bbox_height(bbox: List[float]) -> float:
    return max(float(bbox[3]) - float(bbox[1]), 0.0)


def _horizontal_overlap(left_bbox: List[float], right_bbox: List[float]) -> float:
    return max(0.0, min(float(left_bbox[2]), float(right_bbox[2])) - max(float(left_bbox[0]), float(right_bbox[0])))


def _transform_point(matrix: List[List[float]], x: float, y: float) -> Tuple[float, float]:
    return (
        matrix[0][0] * x + matrix[0][1] * y + matrix[0][2],
        matrix[1][0] * x + matrix[1][1] * y + matrix[1][2],
    )


def _transform_bbox(bbox: List[float], matrix: List[List[float]]) -> List[float]:
    x0, y0, x1, y1 = [float(v) for v in bbox]
    points = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    transformed = [_transform_point(matrix, x, y) for x, y in points]
    xs = [point[0] for point in transformed]
    ys = [point[1] for point in transformed]
    return [min(xs), min(ys), max(xs), max(ys)]


def _build_region_rotation_transform(
    region_bbox: List[float],
    rotation: int,
) -> Dict[str, Any]:
    x0, y0, x1, y1 = [float(v) for v in region_bbox]
    width = max(x1 - x0, 0.0)
    height = max(y1 - y0, 0.0)
    normalized_width = width
    normalized_height = height
    if rotation == 0:
        matrix = [
            [1.0, 0.0, -x0],
            [0.0, 1.0, -y0],
            [0.0, 0.0, 1.0],
        ]
        inverse = [
            [1.0, 0.0, x0],
            [0.0, 1.0, y0],
            [0.0, 0.0, 1.0],
        ]
    elif rotation == 90:
        normalized_width = height
        normalized_height = width
        matrix = [
            [0.0, 1.0, -y0],
            [-1.0, 0.0, x0 + width],
            [0.0, 0.0, 1.0],
        ]
        inverse = [
            [0.0, -1.0, x0 + width],
            [1.0, 0.0, y0],
            [0.0, 0.0, 1.0],
        ]
    elif rotation == 270:
        normalized_width = height
        normalized_height = width
        matrix = [
            [0.0, -1.0, y0 + height],
            [1.0, 0.0, -x0],
            [0.0, 0.0, 1.0],
        ]
        inverse = [
            [0.0, 1.0, x0],
            [-1.0, 0.0, y0 + height],
            [0.0, 0.0, 1.0],
        ]
    else:
        raise ValueError(f"unsupported rotation: {rotation}")
    return {
        "regionBBox": [x0, y0, x1, y1],
        "rotation": rotation,
        "matrix": matrix,
        "inverseMatrix": inverse,
        "normalizedWidth": normalized_width,
        "normalizedHeight": normalized_height,
    }


def _vertical_gap(upper_bbox: List[float], lower_bbox: List[float]) -> float:
    return float(lower_bbox[1]) - float(upper_bbox[3])


def _union_bboxes(boxes: Iterable[List[float]]) -> Optional[List[float]]:
    box_list = [box for box in boxes if len(box) == 4]
    if not box_list:
        return None
    return [
        min(float(box[0]) for box in box_list),
        min(float(box[1]) for box in box_list),
        max(float(box[2]) for box in box_list),
        max(float(box[3]) for box in box_list),
    ]


def _load_blocks(input_path: Path, pages: Optional[List[int]]) -> Tuple[Dict[str, Any], Optional[Path]]:
    if input_path.suffix.lower() == ".json":
        return json.loads(input_path.read_text(encoding="utf-8")), None

    from services.pdf_services import extract_pdf_blocks

    temp = tempfile.NamedTemporaryFile(prefix="wasabi_table_detect_", suffix=".json", delete=False)
    temp_path = Path(temp.name)
    temp.close()
    extract_pdf_blocks(str(input_path), str(temp_path), pages)
    data = json.loads(temp_path.read_text(encoding="utf-8"))
    data["_pageLineHints"] = _extract_page_line_hints(input_path, pages)
    return data, temp_path


def mark_table_blocks(
    data: Dict[str, Any],
    detection: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if detection is None:
        detection = detect_tables(data)

    blocks = _iter_blocks(data)
    blocks_by_id = {
        str(block.get("id") or ""): block
        for block in blocks
        if str(block.get("id") or "")
    }

    for page in detection.get("pages") or []:
        for structure in page.get("structures") or page.get("tables") or []:
            if str(structure.get("kind") or "") != "table":
                continue
            table_id = str(structure.get("id") or "")
            for block_id in structure.get("bodyBlockIds") or []:
                block = blocks_by_id.get(str(block_id))
                if block is None:
                    continue
                block["blockType"] = "table_body"
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "table_structure"
                block["tableId"] = table_id
                block["tableRole"] = "body"
            for block_id in structure.get("headerBlockIds") or []:
                block = blocks_by_id.get(str(block_id))
                if block is None:
                    continue
                block["blockType"] = "table_header"
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "table_structure"
                block["tableId"] = table_id
                block["tableRole"] = "header"
            for block_id in structure.get("captionBlockIds") or []:
                block = blocks_by_id.get(str(block_id))
                if block is None:
                    continue
                block["tableId"] = table_id
                block["tableRole"] = "caption"
            for block_id in structure.get("footnoteBlockIds") or []:
                block = blocks_by_id.get(str(block_id))
                if block is None:
                    continue
                block["tableId"] = table_id
                block["tableRole"] = "footnote"

    return detection


def _iter_blocks(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    blocks = data.get("blocks")
    if isinstance(blocks, list):
        return blocks
    items: List[Dict[str, Any]] = []
    for page in data.get("pages") or []:
        items.extend(page.get("blocks") or [])
    return items


def _group_blocks_by_page(blocks: Iterable[Dict[str, Any]]) -> Dict[int, List[Dict[str, Any]]]:
    grouped: Dict[int, List[Dict[str, Any]]] = {}
    for block in blocks:
        try:
            page = int(block.get("page") or 0)
        except Exception:
            continue
        grouped.setdefault(page, []).append(block)
    for page_blocks in grouped.values():
        page_blocks.sort(key=lambda block: (_bbox(block) or [0.0, 0.0, 0.0, 0.0])[1])
    return grouped


def _extract_page_line_hints(pdf_path: Path, pages: Optional[List[int]]) -> Dict[int, List[List[float]]]:
    doc = fitz.open(str(pdf_path))
    selected_pages = set(pages) if pages else None
    hints: Dict[int, List[List[float]]] = {}
    try:
        for page_index in range(doc.page_count):
            page_no = page_index + 1
            if selected_pages is not None and page_no not in selected_pages:
                continue
            page = doc[page_index]
            page_lines: List[List[float]] = []
            for drawing in page.get_drawings():
                rect = drawing.get("rect")
                if not rect:
                    continue
                x0, y0, x1, y1 = [float(v) for v in rect]
                width = x1 - x0
                height = y1 - y0
                is_horizontal = width >= 150.0 and height <= 3.0
                is_vertical = height >= 150.0 and width <= 3.0
                if not (is_horizontal or is_vertical):
                    continue
                page_lines.append([x0, y0, x1, y1])
            if page_lines:
                page_lines.sort(key=lambda line: (line[1], line[0]))
                hints[page_no] = page_lines
    finally:
        doc.close()
    return hints


def _group_horizontal_rules(page_lines: List[List[float]], page_width: float) -> List[List[List[float]]]:
    if not page_lines:
        return []

    min_width = max(page_width * 0.35, 180.0)
    filtered = [line for line in page_lines if _bbox_width(line) >= min_width]
    filtered.sort(key=lambda line: (_bbox_width(line), line[0], line[2]), reverse=True)

    groups: List[List[List[float]]] = []
    for line in filtered:
        matched_group: Optional[List[List[float]]] = None
        for group in groups:
            sample = group[0]
            if abs(float(line[0]) - float(sample[0])) <= 18.0 and abs(float(line[2]) - float(sample[2])) <= 18.0:
                matched_group = group
                break
        if matched_group is None:
            matched_group = []
            groups.append(matched_group)
        matched_group.append(line)

    normalized_groups: List[List[List[float]]] = []
    for group in groups:
        unique_lines = sorted(
            {
                (round(float(line[0]), 3), round(float(line[1]), 3), round(float(line[2]), 3), round(float(line[3]), 3))
                for line in group
            },
            key=lambda line: (line[1], line[0]),
        )
        normalized_group = [[line[0], line[1], line[2], line[3]] for line in unique_lines]
        if len(normalized_group) >= 3:
            normalized_groups.append(normalized_group)
    return normalized_groups


def _split_horizontal_rule_group(group: List[List[float]]) -> List[List[List[float]]]:
    if len(group) < 4:
        return [group]

    gaps = [
        float(group[index + 1][1]) - float(group[index][1])
        for index in range(len(group) - 1)
    ]
    positive_gaps = [gap for gap in gaps if gap > 0.0]
    if not positive_gaps:
        return [group]

    median_gap = statistics.median(positive_gaps)
    split_after: List[int] = []
    for index, gap in enumerate(gaps):
        if gap > max(60.0, median_gap * 2.0):
            split_after.append(index + 1)

    if not split_after:
        return [group]

    parts: List[List[List[float]]] = []
    start = 0
    for stop in split_after + [len(group)]:
        part = group[start:stop]
        if len(part) >= 3:
            parts.append(part)
        start = stop
    return parts or [group]


def _build_rule_regions(page_lines: List[List[float]], page_width: float) -> List[Dict[str, Any]]:
    regions: List[Dict[str, Any]] = []
    for group in _group_horizontal_rules(page_lines, page_width):
        for subgroup in _split_horizontal_rule_group(group):
            group_bbox = _union_bboxes(subgroup)
            if group_bbox is None:
                continue
            height = _bbox_height(group_bbox)
            width = _bbox_width(group_bbox)
            if height < 24.0 or width < max(page_width * 0.35, 180.0):
                continue
            gaps = [
                float(subgroup[index + 1][1]) - float(subgroup[index][1])
                for index in range(len(subgroup) - 1)
            ]
            if not gaps:
                continue
            if max(gaps) > 120.0:
                continue
            regions.append(
                {
                    "bbox": group_bbox,
                    "lines": subgroup,
                    "maxGap": max(gaps),
                }
            )
    regions.sort(key=lambda region: (float(region["bbox"][1]), float(region["bbox"][0])))
    return regions


def _split_rule_region_by_captions(
    region: Dict[str, Any],
    page_blocks: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    region_bbox = region.get("bbox") or []
    lines = list(region.get("lines") or [])
    if len(region_bbox) != 4 or len(lines) < 4:
        return [region]

    caption_splits: List[int] = []
    for block in page_blocks:
        if str(block.get("blockType") or "") != "caption":
            continue
        caption_bbox = _bbox(block)
        if caption_bbox is None:
            continue
        overlap = _horizontal_overlap(caption_bbox, region_bbox)
        overlap_ratio = overlap / max(min(_bbox_width(caption_bbox), _bbox_width(region_bbox)), 1.0)
        if overlap_ratio < 0.60:
            continue
        if float(caption_bbox[1]) <= float(region_bbox[1]) + 8.0:
            continue
        if float(caption_bbox[3]) >= float(region_bbox[3]) - 8.0:
            continue
        for index in range(len(lines) - 1):
            upper = lines[index]
            lower = lines[index + 1]
            if float(upper[1]) <= float(caption_bbox[1]) and float(lower[1]) >= float(caption_bbox[3]):
                if index + 1 not in caption_splits:
                    caption_splits.append(index + 1)
                break

    if not caption_splits:
        return [region]

    parts: List[Dict[str, Any]] = []
    start = 0
    for stop in sorted(caption_splits) + [len(lines)]:
        sublines = lines[start:stop]
        if len(sublines) >= 3:
            bbox = _union_bboxes(sublines)
            if bbox is not None:
                gaps = [
                    float(sublines[index + 1][1]) - float(sublines[index][1])
                    for index in range(len(sublines) - 1)
                ]
                parts.append(
                    {
                        "bbox": bbox,
                        "lines": sublines,
                        "maxGap": max(gaps) if gaps else 0.0,
                    }
                )
        start = stop
    return parts or [region]


def _looks_like_sentence_text(text: str, numeric_tokens: int) -> bool:
    sentence_punct = len(re.findall(r"[，。；：!?]", text))
    if sentence_punct >= 2 and numeric_tokens < 4:
        return True
    if len(text) >= 90 and sentence_punct >= 1 and numeric_tokens < 5:
        return True
    latin_words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
    if len(latin_words) >= 40 and re.search(r"[.,;:]", text):
        return True
    if len(latin_words) >= 14 and numeric_tokens <= 10:
        if re.search(r"[.,;:]", text):
            return True
        if text.strip().lower().startswith(("from ", "we ", "this ", "that ", "by ", "for ")):
            return True
    return False


def _block_text_items(block: Dict[str, Any]) -> List[str]:
    texts: List[str] = []
    for line in block.get("layoutLines") or []:
        for item in line.get("items") or []:
            if str(item.get("type") or "") not in {"text", "formula"}:
                continue
            text = str(item.get("text") or "").strip()
            if text:
                texts.append(text)
    return texts


def _block_structure_stats(block: Dict[str, Any]) -> Dict[str, float]:
    items = _block_text_items(block)
    if not items:
        return {
            "item_count": 0.0,
            "short_ratio": 0.0,
            "numeric_ratio": 0.0,
            "median_len": 0.0,
        }

    lengths = [len(common.normalize_text(text)) for text in items]
    short_count = sum(1 for length in lengths if 0 < length <= 12)
    numeric_like_count = sum(
        1
        for text in items
        if re.search(r"\d", text) or any(symbol in text for symbol in ("↑", "↓", "%", "@", "±"))
    )
    lengths_sorted = sorted(length for length in lengths if length > 0)
    median_len = lengths_sorted[len(lengths_sorted) // 2] if lengths_sorted else 0.0
    return {
        "item_count": float(len(items)),
        "short_ratio": short_count / max(len(items), 1),
        "numeric_ratio": numeric_like_count / max(len(items), 1),
        "median_len": float(median_len),
    }


def _iter_line_item_boxes(block: Dict[str, Any]) -> List[List[List[float]]]:
    line_boxes: List[List[List[float]]] = []
    for line in block.get("layoutLines") or []:
        item_boxes: List[List[float]] = []
        for item in line.get("items") or []:
            bbox = item.get("bbox") or []
            if len(bbox) != 4:
                continue
            item_type = str(item.get("type") or "")
            if item_type not in {"text", "formula"}:
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            item_boxes.append([float(v) for v in bbox])
        if item_boxes:
            item_boxes.sort(key=lambda box: (box[0], box[1]))
            line_boxes.append(item_boxes)
    return line_boxes


def _iter_block_item_boxes(block: Dict[str, Any]) -> List[List[float]]:
    item_boxes: List[List[float]] = []
    for line in block.get("layoutLines") or []:
        for item in line.get("items") or []:
            bbox = item.get("bbox") or []
            if len(bbox) != 4:
                continue
            item_type = str(item.get("type") or "")
            if item_type not in {"text", "formula"}:
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            item_boxes.append([float(v) for v in bbox])
    item_boxes.sort(key=lambda box: ((box[1] + box[3]) / 2.0, box[0]))
    return item_boxes


def _group_item_boxes_into_rows(block: Dict[str, Any], y_tolerance: float = 6.0) -> List[List[List[float]]]:
    rows: List[List[List[float]]] = []
    for box in _iter_block_item_boxes(block):
        y_center = (float(box[1]) + float(box[3])) / 2.0
        matched = False
        for row in rows:
            sample_center = sum((float(item[1]) + float(item[3])) / 2.0 for item in row) / len(row)
            if abs(y_center - sample_center) <= y_tolerance:
                row.append(box)
                matched = True
                break
        if not matched:
            rows.append([box])
    for row in rows:
        row.sort(key=lambda item: item[0])
    return rows


def _count_stable_anchor_bins(values: List[float], tolerance: float, min_count: int) -> int:
    if not values:
        return 0
    bins: List[List[float]] = []
    for value in sorted(values):
        matched = False
        for group in bins:
            center = sum(group) / len(group)
            if abs(value - center) <= tolerance:
                group.append(value)
                matched = True
                break
        if not matched:
            bins.append([value])
    return sum(1 for group in bins if len(group) >= min_count)


def _body_has_internal_column_evidence(block: Dict[str, Any]) -> bool:
    row_boxes = _group_item_boxes_into_rows(block)
    if len(row_boxes) < 6:
        return False

    multi_item_lines = [boxes for boxes in row_boxes if len(boxes) >= 3]
    if len(multi_item_lines) < 4:
        return False

    left_anchors: List[float] = []
    right_anchors: List[float] = []
    gap_lines = 0
    for boxes in multi_item_lines:
        gaps = [float(boxes[index + 1][0]) - float(boxes[index][2]) for index in range(len(boxes) - 1)]
        if any(gap >= 18.0 for gap in gaps):
            gap_lines += 1
        left_anchors.extend(float(box[0]) for box in boxes[1:])
        right_anchors.extend(float(box[2]) for box in boxes[:-1])

    if gap_lines < 4:
        return False

    stable_lefts = _count_stable_anchor_bins(left_anchors, tolerance=12.0, min_count=4)
    stable_rights = _count_stable_anchor_bins(right_anchors, tolerance=12.0, min_count=4)
    return stable_lefts >= 2 or stable_rights >= 2


def _body_has_compact_table_evidence(block: Dict[str, Any], page_width: float) -> bool:
    bbox = _bbox(block)
    if bbox is None:
        return False
    width = _bbox_width(bbox)
    if width > max(page_width * 0.50, 310.0):
        return False
    raw_text = str(block.get("text") or "").strip()
    normalized = common.normalize_text(raw_text)
    if len(normalized) < 16:
        return False
    numeric_tokens = len(re.findall(r"\b\d+(?:\.\d+)?(?:%|\+\d+%)?\b", normalized))
    if numeric_tokens < 4:
        return False
    if _looks_like_sentence_text(raw_text, numeric_tokens):
        return False

    line_count = len(block.get("layoutLines") or [])
    if line_count < 6:
        return False

    item_boxes: List[List[float]] = []
    short_tokens = 0
    token_count = 0
    for line in block.get("layoutLines") or []:
        for item in line.get("items") or []:
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            token_count += 1
            if len(common.normalize_text(text)) <= 18:
                short_tokens += 1
            item_bbox = item.get("bbox") or []
            if len(item_bbox) == 4:
                item_boxes.append([float(v) for v in item_bbox])
    if token_count < 8 or len(item_boxes) < 8:
        return False
    if short_tokens / max(token_count, 1) < 0.8:
        return False

    left_anchors = [float(box[0]) for box in item_boxes]
    right_anchors = [float(box[2]) for box in item_boxes]
    stable_lefts = _count_stable_anchor_bins(left_anchors, tolerance=14.0, min_count=2)
    stable_rights = _count_stable_anchor_bins(right_anchors, tolerance=14.0, min_count=2)
    return stable_lefts >= 2 or stable_rights >= 2


def _is_single_body_table_candidate(block: Dict[str, Any], page_width: float) -> bool:
    block_type = str(block.get("blockType") or "")
    if block_type not in {"table_body", "metadata", "body"}:
        return False
    return _body_has_internal_column_evidence(block) or _body_has_compact_table_evidence(block, page_width)


def _looks_like_figure_label_cluster(
    cluster: List[Dict[str, Any]],
    cluster_bbox: List[float],
) -> bool:
    if len(cluster) == 0 or len(cluster) > 4:
        return False
    if _bbox_height(cluster_bbox) > 72.0:
        return False

    total_items = 0
    total_lines = 0
    numeric_tokens = 0
    short_blocks = 0
    structured_blocks = 0

    for block in cluster:
        raw_text = str(block.get("text") or "").strip()
        normalized = common.normalize_text(raw_text)
        if not normalized:
            continue
        stats = _block_structure_stats(block)
        total_items += int(stats["item_count"])
        total_lines += len(block.get("layoutLines") or [])
        numeric_tokens += len(re.findall(r"\b\d+(?:\.\d+)?[KMBkmb%]?\b", normalized))
        if len(normalized) <= 36 and stats["median_len"] <= 12:
            short_blocks += 1
        if len(block.get("layoutLines") or []) >= 8 or stats["item_count"] >= 10:
            structured_blocks += 1

    if structured_blocks > 0:
        return False
    if numeric_tokens >= 3:
        return False
    if total_lines > 10 or total_items > 12:
        return False
    return short_blocks >= max(len(cluster) - 1, 1)


def _looks_like_headerish_block(block: Dict[str, Any], page_width: float) -> bool:
    bbox = _bbox(block)
    if bbox is None:
        return False
    raw_text = str(block.get("text") or "").strip()
    normalized = common.normalize_text(raw_text)
    stats = _block_structure_stats(block)
    if not normalized:
        return False
    if len(normalized) > 120:
        return False
    if len(normalized) > 72 and stats["item_count"] < 5:
        return False
    if _looks_like_formula_text(block, page_width):
        return False

    line_count = len(block.get("layoutLines") or [])
    width = _bbox_width(bbox)
    height = _bbox_height(bbox)
    numeric_tokens = len(re.findall(r"\b\d+(?:\.\d+)?[KMBkmb%]?\b", normalized))
    columnar_token_band = (
        stats["item_count"] >= 8
        and stats["short_ratio"] >= 0.85
        and stats["median_len"] <= 4
        and numeric_tokens <= 2
    )

    if _looks_like_sentence_text(raw_text, numeric_tokens) and not columnar_token_band:
        return False
    if width < max(page_width * 0.18, 90.0):
        return False
    if height > max(float(block.get("fontSize") or 0.0) * 5.5, 42.0):
        return False

    return (
        stats["item_count"] >= 2
        or line_count >= 2
        or (stats["short_ratio"] >= 0.7 and stats["median_len"] <= 12)
    )


def _is_algorithm_caption_block(block: Dict[str, Any]) -> bool:
    block_type = str(block.get("blockType") or "")
    if block_type in {"page_header", "page_footer", "other", "footnote", "reference_block"}:
        return False
    text = str(block.get("text") or "").strip()
    if not text:
        return False
    return bool(re.match(r"^algorithm\s+\d+\b", text, flags=re.IGNORECASE))


def _looks_like_algorithm_body_block(block: Dict[str, Any], page_width: float) -> bool:
    block_type = str(block.get("blockType") or "")
    if block_type in {"heading", "caption", "page_header", "page_footer", "other", "footnote", "reference_block"}:
        return False
    if block.get("role") == "heading":
        return False
    bbox = _bbox(block)
    if bbox is None:
        return False
    if _bbox_width(bbox) < max(page_width * 0.45, 220.0):
        return False

    raw_text = str(block.get("text") or "").strip()
    normalized = common.normalize_text(raw_text)
    if len(normalized) < 24:
        return False

    line_count = len(block.get("layoutLines") or [])
    step_markers = len(re.findall(r"(?:^|\s)\d{1,2}:", raw_text))
    keyword_hits = sum(
        1
        for marker in ("Input", "Output", "procedure", "for step", "return", "while", "repeat", "queue", "loss", "update")
        if marker.lower() in raw_text.lower()
    )
    assignment_hits = raw_text.count("←") + raw_text.count("▷")
    stats = _block_structure_stats(block)
    numeric_tokens = len(re.findall(r"\b\d+(?:\.\d+)?[KMBkmb%]?\b", normalized))
    if _looks_like_sentence_text(raw_text, numeric_tokens) and step_markers == 0 and keyword_hits < 2:
        return False

    return (
        step_markers >= 2
        or (
            line_count >= 6
            and (keyword_hits >= 2 or assignment_hits >= 2)
            and stats["item_count"] >= 8
        )
    )


def _find_algorithm_structures(
    page_no: int,
    page_blocks: List[Dict[str, Any]],
    page_width: float,
    used_block_ids: set[str],
) -> List[Dict[str, Any]]:
    structures: List[Dict[str, Any]] = []
    algo_index = 1
    sorted_page_blocks = sorted(
        page_blocks,
        key=lambda block: (
            float((_bbox(block) or [0.0, 0.0, 0.0, 0.0])[1]),
            float((_bbox(block) or [0.0, 0.0, 0.0, 0.0])[0]),
        ),
    )
    for caption in sorted_page_blocks:
        caption_id = str(caption.get("id") or "")
        if caption_id in used_block_ids or not _is_algorithm_caption_block(caption):
            continue
        caption_bbox = _bbox(caption)
        if caption_bbox is None:
            continue

        current_bottom = float(caption_bbox[3])
        body_blocks: List[Dict[str, Any]] = []
        for block in sorted_page_blocks:
            block_id = str(block.get("id") or "")
            if block_id in used_block_ids or block is caption:
                continue
            bbox = _bbox(block)
            if bbox is None:
                continue
            if not body_blocks and float(bbox[1]) < current_bottom - 6.0:
                continue
            gap = float(bbox[1]) - current_bottom
            if body_blocks:
                gap = max(0.0, gap)
            if gap > 24.0:
                break
            overlap = _horizontal_overlap(caption_bbox, bbox)
            overlap_ratio = overlap / max(min(_bbox_width(caption_bbox), _bbox_width(bbox)), 1.0)
            if overlap_ratio < 0.72:
                continue
            if not _looks_like_algorithm_body_block(block, page_width):
                if body_blocks:
                    break
                continue
            body_blocks.append(block)
            current_bottom = max(current_bottom, float(bbox[3]))

        if not body_blocks:
            continue

        body_boxes = [_bbox(block) for block in body_blocks if _bbox(block) is not None]
        bbox = _union_bboxes([caption_bbox] + body_boxes)
        if bbox is None:
            continue
        structure = {
            "id": f"p{page_no}_a{algo_index}",
            "kind": "algorithm",
            "bbox": bbox,
            "displayBBox": bbox,
            "bodyBlockIds": [str(block.get("id") or "") for block in body_blocks],
            "headerBlockIds": [],
            "captionBlockIds": [caption_id],
            "bodyTexts": [str(block.get("text") or "") for block in body_blocks],
            "headerTexts": [],
            "captionTexts": [str(caption.get("text") or "")],
        }
        structures.append(structure)
        used_block_ids.add(caption_id)
        for block in body_blocks:
            used_block_ids.add(str(block.get("id") or ""))
        algo_index += 1
    return structures


def _has_code_markers(normalized: str) -> bool:
    lower = normalized.lower()
    return any(
        marker in lower
        for marker in (
            "max(",
            "round(",
            "self.",
            "return {",
            "return {",
            "float(",
            '"""',
            "# ",
        )
    )


def _looks_like_formula_text(block: Dict[str, Any], page_width: float) -> bool:
    bbox = _bbox(block)
    if bbox is None:
        return False
    block_type = str(block.get("blockType") or "")
    if block_type in {"table_body", "table_header"} and _bbox_width(bbox) >= max(page_width * 0.35, 180.0):
        return False
    raw_text = str(block.get("text") or "").strip()
    normalized = common.normalize_text(raw_text)
    if not normalized:
        return False

    layout_line_count = len(block.get("layoutLines") or [])
    width = _bbox_width(bbox)
    if width > max(page_width * 0.72, 360.0):
        return False

    if re.search(r"\b(?:sin|cos|max|min|softmax|concat|attention)\s*\(", normalized, flags=re.IGNORECASE):
        return True
    if any(symbol in raw_text for symbol in ("∈", "∀", "∑", "√")):
        return True
    if raw_text.count("=") >= 1 and raw_text.count("(") >= 1 and layout_line_count <= 4:
        return True
    if raw_text.count("(") >= 2 and raw_text.count(")") >= 2 and layout_line_count <= 4:
        return True
    if re.search(r"\b[A-Za-z]\w*\s*=", raw_text) and layout_line_count <= 4:
        return True
    return False


def _is_table_seed_candidate(block: Dict[str, Any], page_width: float) -> bool:
    block_type = str(block.get("blockType") or "")
    if block_type in {
        "caption",
        "heading",
        "page_header",
        "page_footer",
        "other",
        "footnote",
        "reference_block",
        "code",
        "formula_display",
    }:
        return False
    if block.get("role") == "heading":
        return False

    bbox = _bbox(block)
    if bbox is None:
        return False
    width = _bbox_width(bbox)

    raw_text = str(block.get("text") or "").strip()
    normalized = common.normalize_text(raw_text)
    if len(normalized) < 12:
        return False
    if _looks_like_formula_text(block, page_width):
        return False

    lower = normalized.lower()
    numeric_tokens = len(re.findall(r"\b\d+(?:\.\d+)?[KMBkmb%]?\b", normalized))
    if _looks_like_sentence_text(raw_text, numeric_tokens):
        return False
    stats = _block_structure_stats(block)
    wide_enough = width >= max(page_width * 0.30, 180.0)
    if (
        block_type in {"table_body", "table_header"}
        and width >= max(page_width * 0.12, 70.0)
        and stats["item_count"] >= 1
        and stats["median_len"] <= 18
    ):
        return True
    if wide_enough and numeric_tokens >= 8:
        return True
    if (
        wide_enough
        and stats["item_count"] >= 6
        and stats["short_ratio"] >= 0.65
        and stats["median_len"] <= 10
    ):
        return True
    if (
        wide_enough
        and numeric_tokens >= 6
        and stats["numeric_ratio"] >= 0.35
        and stats["short_ratio"] >= 0.45
    ):
        return True
    return False


def _is_table_supporting_candidate(block: Dict[str, Any], page_width: float) -> bool:
    block_type = str(block.get("blockType") or "")
    if block_type in {
        "caption",
        "heading",
        "page_header",
        "page_footer",
        "other",
        "footnote",
        "reference_block",
        "code",
        "formula_display",
    }:
        return False
    if block.get("role") == "heading":
        return False

    bbox = _bbox(block)
    if bbox is None:
        return False
    width = _bbox_width(bbox)
    raw_text = str(block.get("text") or "").strip()
    normalized = common.normalize_text(raw_text)
    if len(normalized) < 8:
        return False
    if _looks_like_formula_text(block, page_width):
        return False

    numeric_tokens = len(re.findall(r"\b\d+(?:\.\d+)?[KMBkmb%]?\b", normalized))
    stats = _block_structure_stats(block)
    if _looks_like_sentence_text(raw_text, numeric_tokens):
        return False
    if (
        block_type in {"table_body", "table_header"}
        and stats["item_count"] >= 1
        and stats["median_len"] <= 18
    ):
        return True
    if (
        width >= max(page_width * 0.28, 170.0)
        and numeric_tokens >= 6
        and stats["numeric_ratio"] >= 0.30
    ):
        return True
    if (
        width >= max(page_width * 0.28, 170.0)
        and stats["item_count"] >= 4
        and stats["short_ratio"] >= 0.65
        and stats["median_len"] <= 12
    ):
        return True
    if (
        width >= max(page_width * 0.20, 120.0)
        and stats["item_count"] <= 4
        and stats["short_ratio"] >= 0.75
        and stats["median_len"] <= 14
    ):
        return True
    return False


def _dedupe_tables(page_tables: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    kept: List[Dict[str, Any]] = []
    seen_sets: List[set[str]] = []
    sorted_tables = sorted(
        page_tables,
        key=lambda table: (
            -len(table.get("bodyBlockIds") or []),
            -len(table.get("headerBlockIds") or []),
            -len(table.get("captionBlockIds") or []),
            table.get("id") or "",
        ),
    )
    for table in sorted_tables:
        body_set = set(table.get("bodyBlockIds") or [])
        if not body_set:
            continue
        duplicate = False
        for existing_set in seen_sets:
            if body_set.issubset(existing_set):
                duplicate = True
                break
            overlap_ratio = len(body_set & existing_set) / max(len(body_set | existing_set), 1)
            if overlap_ratio >= 0.8:
                duplicate = True
                break
        if duplicate:
            continue
        kept.append(table)
        seen_sets.append(body_set)
    kept.sort(key=lambda table: table.get("id") or "")
    return kept


def _is_table_header_candidate(block: Dict[str, Any], table_blocks: List[Dict[str, Any]], page_width: float) -> bool:
    if str(block.get("blockType") or "") not in {"body", "metadata", "table_header", "table_body"}:
        return False
    if block.get("preserveOriginal"):
        return False

    bbox = _bbox(block)
    if bbox is None:
        return False
    width = _bbox_width(bbox)
    height = _bbox_height(bbox)
    font_size = float(block.get("fontSize") or 0.0)
    layout_lines = block.get("layoutLines") or []
    table_boxes = [_bbox(table_block) for table_block in table_blocks]
    table_boxes = [table_box for table_box in table_boxes if table_box is not None]
    if not table_boxes:
        return False
    table_top = min(float(table_box[1]) for table_box in table_boxes)
    if float(bbox[1]) >= table_top:
        return False

    if width < max(page_width * 0.30, 180.0):
        return False
    if height > max(font_size * 3.2, 28.0):
        return False

    line_tops: List[float] = []
    for line in layout_lines:
        line_bbox = line.get("bbox") or []
        if len(line_bbox) != 4:
            return False
        line_tops.append(float(line_bbox[1]))
    if not line_tops:
        return False
    if max(line_tops) - min(line_tops) > max(font_size * 3.0, 28.0):
        return False

    adjacent_to_known_table = False
    for table_bbox in table_boxes:
        overlap = _horizontal_overlap(bbox, table_bbox)
        overlap_ratio = overlap / max(min(width, max(_bbox_width(table_bbox), 1.0)), 1.0)
        gap = _vertical_gap(bbox, table_bbox)
        if overlap_ratio < 0.50:
            continue
        if gap < -4.0 or gap > max(font_size * 3.0, 24.0):
            continue
        adjacent_to_known_table = True
        break
    if not adjacent_to_known_table:
        return False

    return _looks_like_headerish_block(block, page_width)


def _find_cluster_headers(
    page_blocks: List[Dict[str, Any]],
    cluster_bbox: List[float],
    page_width: float,
) -> List[Dict[str, Any]]:
    headers: List[Dict[str, Any]] = []
    for block in page_blocks:
        bbox = _bbox(block)
        if bbox is None:
            continue
        if float(bbox[1]) >= float(cluster_bbox[1]):
            continue
        overlap = _horizontal_overlap(bbox, cluster_bbox)
        overlap_ratio = overlap / max(min(_bbox_width(bbox), _bbox_width(cluster_bbox)), 1.0)
        gap = _vertical_gap(bbox, cluster_bbox)
        if overlap_ratio < 0.50:
            continue
        if gap < -4.0 or gap > 28.0:
            continue
        if not _looks_like_headerish_block(block, page_width):
            continue
        headers.append(block)
    headers.sort(key=lambda block: (_bbox(block) or [0.0, 0.0, 0.0, 0.0])[1])
    return headers


def _merge_adjacent_tables(
    page_tables: List[Dict[str, Any]],
    page_blocks: List[Dict[str, Any]],
    max_gap: float = 34.0,
) -> List[Dict[str, Any]]:
    if len(page_tables) < 2:
        return page_tables

    block_index = {str(block.get("id") or ""): block for block in page_blocks}
    tables = sorted(page_tables, key=lambda table: (float(table["bbox"][1]), float(table["bbox"][0])))

    def can_merge(upper: Dict[str, Any], lower: Dict[str, Any]) -> bool:
        if lower.get("captionBlockIds"):
            return False
        upper_bbox = [float(v) for v in upper["bbox"]]
        lower_bbox = [float(v) for v in lower["bbox"]]
        overlap = _horizontal_overlap(upper_bbox, lower_bbox)
        overlap_ratio = overlap / max(min(_bbox_width(upper_bbox), _bbox_width(lower_bbox)), 1.0)
        gap = _vertical_gap(upper_bbox, lower_bbox)
        if overlap_ratio < 0.78:
            return False
        if gap < -4.0 or gap > max_gap:
            return False
        if abs(float(upper_bbox[2]) - float(lower_bbox[2])) > 24.0:
            return False

        ignored_ids = set(upper.get("bodyBlockIds") or []) | set(lower.get("bodyBlockIds") or [])
        ignored_ids |= set(upper.get("headerBlockIds") or []) | set(lower.get("headerBlockIds") or [])
        ignored_ids |= set(upper.get("captionBlockIds") or []) | set(lower.get("captionBlockIds") or [])

        corridor = [
            min(float(upper_bbox[0]), float(lower_bbox[0])),
            float(upper_bbox[3]),
            max(float(upper_bbox[2]), float(lower_bbox[2])),
            float(lower_bbox[1]),
        ]
        for block in page_blocks:
            block_id = str(block.get("id") or "")
            if block_id in ignored_ids:
                continue
            bbox = _bbox(block)
            if bbox is None:
                continue
            overlap = _horizontal_overlap(bbox, corridor)
            overlap_ratio = overlap / max(min(_bbox_width(bbox), _bbox_width(corridor)), 1.0)
            if overlap_ratio < 0.45:
                continue
            y_center = (float(bbox[1]) + float(bbox[3])) / 2.0
            if y_center <= float(corridor[1]) or y_center >= float(corridor[3]):
                continue
            block_type = str(block.get("blockType") or "")
            role = str(block.get("role") or "")
            if block_type in {"heading", "caption", "page_header", "page_footer"} or role == "heading":
                return False
            if _looks_like_sentence_text(str(block.get("text") or ""), 0):
                return False
        return True

    merged: List[Dict[str, Any]] = []
    index = 0
    while index < len(tables):
        current = dict(tables[index])
        while index + 1 < len(tables) and can_merge(current, tables[index + 1]):
            next_table = tables[index + 1]
            current["bbox"] = _union_bboxes([current["bbox"], next_table["bbox"]]) or current["bbox"]
            current["displayBBox"] = _union_bboxes([current["displayBBox"], next_table["displayBBox"]]) or current["displayBBox"]
            for key in ("bodyBlockIds", "headerBlockIds", "captionBlockIds", "bodyTexts", "headerTexts", "captionTexts"):
                combined = list(current.get(key) or []) + list(next_table.get(key) or [])
                deduped: List[Any] = []
                seen: set[str] = set()
                for item in combined:
                    marker = json.dumps(item, ensure_ascii=False) if not isinstance(item, str) else item
                    if marker in seen:
                        continue
                    seen.add(marker)
                    deduped.append(item)
                current[key] = deduped
            index += 1
        merged.append(current)
        index += 1

    for idx, table in enumerate(merged, start=1):
        match = re.match(r"^p(\d+)(?:_t|_single_)", str(table.get("id") or ""))
        page_no = int(match.group(1)) if match else 0
        table["id"] = f"p{page_no}_t{idx}"
    return merged


def _is_table_caption_block(block: Dict[str, Any]) -> bool:
    if str(block.get("blockType") or "") != "caption":
        return False
    text = str(block.get("text") or "").strip()
    if not text:
        return False
    return bool(re.match(r"^(?:table|表)\s*\d+\b", text, flags=re.IGNORECASE))


def _refine_bbox_with_horizontal_rules(
    bbox: List[float],
    page_lines: List[List[float]],
) -> List[float]:
    if not page_lines:
        return bbox

    x0, y0, x1, y1 = bbox
    top_rule: Optional[List[float]] = None
    bottom_rule: Optional[List[float]] = None

    for line in page_lines:
        overlap = _horizontal_overlap(line, bbox)
        overlap_ratio = overlap / max(min(_bbox_width(line), _bbox_width(bbox)), 1.0)
        if overlap_ratio < 0.70:
            continue
        ly = float(line[1])
        if ly <= y0 and (y0 - ly) <= 36.0:
            if top_rule is None or ly < float(top_rule[1]):
                top_rule = line
        if ly >= y1 and (ly - y1) <= 18.0:
            if bottom_rule is None or ly > float(bottom_rule[1]):
                bottom_rule = line

    refined = list(bbox)
    horizontal_lines = [line for line in (top_rule, bottom_rule) if line is not None]
    if horizontal_lines:
        refined[0] = min([refined[0]] + [float(line[0]) for line in horizontal_lines])
        refined[2] = max([refined[2]] + [float(line[2]) for line in horizontal_lines])
    if top_rule is not None:
        refined[1] = min(refined[1], float(top_rule[1]))
    if bottom_rule is not None:
        refined[3] = max(refined[3], float(bottom_rule[3]))
    return refined


def _collect_blocks_for_rule_region(
    page_blocks: List[Dict[str, Any]],
    region_bbox: List[float],
) -> List[Dict[str, Any]]:
    assigned: List[Dict[str, Any]] = []
    for block in page_blocks:
        if str(block.get("blockType") or "") == "caption":
            continue
        bbox = _bbox(block)
        if bbox is None:
            continue
        overlap = _horizontal_overlap(bbox, region_bbox)
        overlap_ratio = overlap / max(min(_bbox_width(bbox), _bbox_width(region_bbox)), 1.0)
        if overlap_ratio < 0.45:
            continue
        y_center = (float(bbox[1]) + float(bbox[3])) / 2.0
        if y_center < float(region_bbox[1]) - 6.0 or y_center > float(region_bbox[3]) + 6.0:
            continue
        assigned.append(block)
    assigned.sort(key=lambda block: (_bbox(block) or [0.0, 0.0, 0.0, 0.0])[1])
    return assigned


def _looks_like_rule_region_table(region_blocks: List[Dict[str, Any]]) -> bool:
    if len(region_blocks) >= 2:
        return True
    if not region_blocks:
        return False
    block = region_blocks[0]
    raw_text = str(block.get("text") or "").strip()
    normalized = common.normalize_text(raw_text)
    numeric_tokens = len(re.findall(r"\b\d+(?:\.\d+)?[KMBkmb%]?\b", normalized))
    stats = _block_structure_stats(block)
    page_width = float(block.get("pageWidth") or 0.0)
    if _looks_like_formula_text(block, page_width):
        return False
    return (
        len(block.get("layoutLines") or []) >= 6
        or stats["item_count"] >= 8
        or numeric_tokens >= 6
        or str(block.get("blockType") or "") in {"table_body", "table_header"}
    )


def _is_footnote_like_block(block: Dict[str, Any], body_bbox: List[float], page_width: float) -> bool:
    bbox = _bbox(block)
    if bbox is None:
        return False
    text = str(block.get("text") or "").strip()
    if not text:
        return False
    overlap = _horizontal_overlap(bbox, body_bbox)
    overlap_ratio = overlap / max(min(_bbox_width(bbox), _bbox_width(body_bbox)), 1.0)
    gap = _vertical_gap(body_bbox, bbox)
    if overlap_ratio < 0.60 or gap < -2.0 or gap > 28.0:
        return False
    if _bbox_width(bbox) < max(page_width * 0.50, 220.0):
        return False
    if float(block.get("fontSize") or 0.0) > 7.5:
        return False
    return bool(re.match(r"^(?:[a-zA-Z*†‡]\b|Note[:.]?)", text))


def _find_single_body_table_header(
    caption: Dict[str, Any],
    body: Dict[str, Any],
    page_blocks: List[Dict[str, Any]],
    page_width: float,
) -> Optional[Dict[str, Any]]:
    caption_bbox = _bbox(caption)
    body_bbox = _bbox(body)
    if caption_bbox is None or body_bbox is None:
        return None

    best: Optional[Dict[str, Any]] = None
    best_score = -1.0
    for block in page_blocks:
        if block is caption or block is body:
            continue
        bbox = _bbox(block)
        if bbox is None:
            continue
        if float(bbox[1]) <= float(caption_bbox[1]) or float(bbox[1]) >= float(body_bbox[1]):
            continue
        gap_from_caption = _vertical_gap(caption_bbox, bbox)
        gap_to_body = _vertical_gap(bbox, body_bbox)
        if gap_from_caption < -2.0 or gap_from_caption > 20.0:
            continue
        if gap_to_body < -2.0 or gap_to_body > 24.0:
            continue
        overlap = _horizontal_overlap(bbox, body_bbox)
        overlap_ratio = overlap / max(min(_bbox_width(bbox), _bbox_width(body_bbox)), 1.0)
        if overlap_ratio < 0.72:
            continue
        if not _looks_like_headerish_block(block, page_width):
            continue
        score = overlap_ratio * 10.0 - gap_to_body * 0.08 + len(block.get("layoutLines") or [])
        if score > best_score:
            best = block
            best_score = score
    return best


def _find_single_body_table_header_above_body(
    body: Dict[str, Any],
    page_blocks: List[Dict[str, Any]],
    page_width: float,
) -> Optional[Dict[str, Any]]:
    body_bbox = _bbox(body)
    if body_bbox is None:
        return None

    best: Optional[Dict[str, Any]] = None
    best_score = -1.0
    for block in page_blocks:
        if block is body:
            continue
        bbox = _bbox(block)
        if bbox is None:
            continue
        gap_to_body = _vertical_gap(bbox, body_bbox)
        if gap_to_body < -2.0 or gap_to_body > 24.0:
            continue
        overlap = _horizontal_overlap(bbox, body_bbox)
        overlap_ratio = overlap / max(min(_bbox_width(bbox), _bbox_width(body_bbox)), 1.0)
        if overlap_ratio < 0.72:
            continue
        if not _looks_like_headerish_block(block, page_width):
            continue
        score = overlap_ratio * 10.0 - gap_to_body * 0.08 + len(block.get("layoutLines") or [])
        if score > best_score:
            best = block
            best_score = score
    return best


def _find_single_body_tables(
    page_blocks: List[Dict[str, Any]],
    page_width: float,
    used_block_ids: set[str],
) -> List[Dict[str, Any]]:
    tables: List[Dict[str, Any]] = []
    captions = [block for block in page_blocks if _is_table_caption_block(block)]
    for caption in captions:
        caption_id = str(caption.get("id") or "")
        if caption_id in used_block_ids:
            continue
        body_candidates = [
            block for block in page_blocks
            if str(block.get("id") or "") not in used_block_ids
            and _is_single_body_table_candidate(block, page_width)
        ]
        caption_bbox = _bbox(caption)
        if caption_bbox is None:
            continue

        best_body: Optional[Dict[str, Any]] = None
        best_header: Optional[Dict[str, Any]] = None
        best_score = -1.0
        for body in body_candidates:
            body_bbox = _bbox(body)
            if body_bbox is None:
                continue
            overlap = _horizontal_overlap(caption_bbox, body_bbox)
            overlap_ratio = overlap / max(min(_bbox_width(caption_bbox), _bbox_width(body_bbox)), 1.0)
            if overlap_ratio < 0.45:
                continue
            gap_above = _vertical_gap(caption_bbox, body_bbox)
            if -2.0 <= gap_above <= 42.0:
                header = _find_single_body_table_header(caption, body, page_blocks, page_width)
                score = overlap_ratio * 10.0 + len(body.get("layoutLines") or []) * 0.08 - gap_above * 0.05
                if header is None:
                    score -= 0.35
                if score > best_score:
                    best_body = body
                    best_header = header
                    best_score = score

            gap_below = _vertical_gap(body_bbox, caption_bbox)
            if -2.0 <= gap_below <= 42.0:
                header_below_caption = _find_single_body_table_header_above_body(body, page_blocks, page_width)
                score_below = overlap_ratio * 10.0 + len(body.get("layoutLines") or []) * 0.08 - gap_below * 0.05
                if header_below_caption is None:
                    score_below -= 0.35
                if score_below > best_score:
                    best_body = body
                    best_header = header_below_caption
                    best_score = score_below

        if best_body is None:
            continue

        body_bbox = _bbox(best_body)
        header_bbox = _bbox(best_header) if best_header is not None else None
        if body_bbox is None:
            continue
        table_blocks = [caption, best_body]
        if best_header is not None:
            table_blocks.insert(1, best_header)
        footnotes: List[Dict[str, Any]] = []
        for block in page_blocks:
            block_id = str(block.get("id") or "")
            if block_id in used_block_ids or block in table_blocks:
                continue
            if _is_footnote_like_block(block, body_bbox, page_width):
                footnotes.append(block)
        display_boxes = [_bbox(block) for block in table_blocks + footnotes]
        display_bbox = _union_bboxes([box for box in display_boxes if box is not None])
        if display_bbox is None:
            continue

        table_id = f"p{int(caption.get('page') or 0)}_single_{len(tables) + 1}"
        tables.append(
            {
                "id": table_id,
                "bbox": _union_bboxes([box for box in (header_bbox, body_bbox) if box is not None]) or body_bbox,
                "displayBBox": display_bbox,
                "bodyBlockIds": [str(best_body.get("id") or "")],
                "headerBlockIds": [str(best_header.get("id") or "")] if best_header is not None else [],
                "captionBlockIds": [caption_id],
                "bodyTexts": [str(best_body.get("text") or "")],
                "headerTexts": [str(best_header.get("text") or "")] if best_header is not None else [],
                "captionTexts": [str(caption.get("text") or "")],
                "footnoteBlockIds": [str(block.get("id") or "") for block in footnotes],
                "footnoteTexts": [str(block.get("text") or "") for block in footnotes],
            }
        )
        used_block_ids.add(caption_id)
        if best_header is not None:
            used_block_ids.add(str(best_header.get("id") or ""))
        used_block_ids.add(str(best_body.get("id") or ""))
        for block in footnotes:
            used_block_ids.add(str(block.get("id") or ""))
    return tables


def _cluster_matches(left: Dict[str, Any], right: Dict[str, Any]) -> bool:
    left_bbox = _bbox(left)
    right_bbox = _bbox(right)
    if left_bbox is None or right_bbox is None:
        return False

    left_width = _bbox_width(left_bbox)
    right_width = _bbox_width(right_bbox)
    overlap = _horizontal_overlap(left_bbox, right_bbox)
    overlap_ratio = overlap / max(min(left_width, right_width, 1e9), 1.0)
    gap = abs(_vertical_gap(left_bbox, right_bbox))

    same_band = abs(left_bbox[1] - right_bbox[1]) <= max(
        float(left.get("fontSize") or 0.0),
        float(right.get("fontSize") or 0.0),
        10.0,
    )
    similar_x = abs(left_bbox[0] - right_bbox[0]) <= 28.0 and abs(left_bbox[2] - right_bbox[2]) <= 32.0

    return overlap_ratio >= 0.45 and gap <= 34.0 and (same_band or similar_x or gap <= 14.0)


def _cluster_table_blocks(table_blocks: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    clusters: List[List[Dict[str, Any]]] = []
    remaining = list(table_blocks)

    while remaining:
        seed = remaining.pop(0)
        cluster = [seed]
        changed = True
        while changed:
            changed = False
            next_remaining: List[Dict[str, Any]] = []
            for candidate in remaining:
                if any(_cluster_matches(member, candidate) for member in cluster):
                    cluster.append(candidate)
                    changed = True
                else:
                    next_remaining.append(candidate)
            remaining = next_remaining
        cluster.sort(key=lambda block: (_bbox(block) or [0.0, 0.0, 0.0, 0.0])[1])
        clusters.append(cluster)
    return clusters


def _expand_cluster(
    cluster: List[Dict[str, Any]],
    page_blocks: List[Dict[str, Any]],
    page_width: float,
) -> List[Dict[str, Any]]:
    expanded = list(cluster)
    expanded_ids = {str(block.get("id") or "") for block in expanded}
    changed = True
    while changed:
        changed = False
        cluster_bbox = _union_bboxes([_bbox(block) for block in expanded if _bbox(block) is not None])
        if cluster_bbox is None:
            break
        next_candidates: List[Dict[str, Any]] = []
        for block in page_blocks:
            block_id = str(block.get("id") or "")
            if block_id in expanded_ids:
                continue
            if not _is_table_supporting_candidate(block, page_width):
                continue
            bbox = _bbox(block)
            if bbox is None:
                continue
            overlap = _horizontal_overlap(bbox, cluster_bbox)
            overlap_ratio = overlap / max(min(_bbox_width(bbox), _bbox_width(cluster_bbox)), 1.0)
            if overlap_ratio < 0.48:
                continue
            gap_above = _vertical_gap(bbox, cluster_bbox)
            gap_below = _vertical_gap(cluster_bbox, bbox)
            near_cluster = (-6.0 <= gap_above <= 16.0) or (-6.0 <= gap_below <= 16.0)
            if near_cluster:
                next_candidates.append(block)
        for block in next_candidates:
            block_id = str(block.get("id") or "")
            if block_id in expanded_ids:
                continue
            expanded.append(block)
            expanded_ids.add(block_id)
            changed = True
        expanded.sort(key=lambda block: (_bbox(block) or [0.0, 0.0, 0.0, 0.0])[1])
    return expanded


def _page_looks_rotated(page_blocks: List[Dict[str, Any]]) -> bool:
    content_blocks = [
        block for block in page_blocks
        if str(block.get("blockType") or "") not in {"page_header", "page_footer"}
    ]
    if not content_blocks:
        return False
    tall_narrow = 0
    for block in content_blocks:
        bbox = _bbox(block)
        if bbox is None:
            continue
        width = _bbox_width(bbox)
        height = _bbox_height(bbox)
        font_size = float(block.get("fontSize") or 0.0)
        if width <= max(font_size * 1.8, 18.0) and height >= max(width * 4.0, 120.0):
            tall_narrow += 1
    return tall_narrow >= 8


def _is_rotated_table_candidate_block(block: Dict[str, Any]) -> bool:
    bbox = _bbox(block)
    if bbox is None:
        return False
    text = str(block.get("text") or "").strip()
    if not text:
        return False
    if "Author Manuscript" in text or "available in PMC" in text or re.search(r"\bPage\s+\d+\b", text):
        return False
    font_size = float(block.get("fontSize") or 0.0)
    width = _bbox_width(bbox)
    height = _bbox_height(bbox)
    block_type = str(block.get("blockType") or "")
    if text.lower().startswith("table"):
        return True
    if block_type in {"table_body", "metadata"} and font_size <= 8.5 and height >= max(width * 3.0, 80.0):
        return True
    if block_type == "heading" and font_size <= 10.5 and height >= max(width * 4.0, 120.0):
        return True
    return False


def _collect_rotated_table_region_blocks(page_blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    candidates = [block for block in page_blocks if _is_rotated_table_candidate_block(block)]
    if len(candidates) < 8:
        return []
    candidate_ids = {str(block.get("id") or "") for block in candidates}
    boxes = [_bbox(block) for block in candidates if _bbox(block) is not None]
    union_bbox = _union_bboxes([box for box in boxes if box is not None])
    if union_bbox is None:
        return []

    changed = True
    while changed:
        changed = False
        for block in page_blocks:
            block_id = str(block.get("id") or "")
            if block_id in candidate_ids:
                continue
            bbox = _bbox(block)
            if bbox is None:
                continue
            text = str(block.get("text") or "").strip()
            if not text:
                continue
            if "Author Manuscript" in text or "available in PMC" in text or re.search(r"\bPage\s+\d+\b", text):
                continue
            width = _bbox_width(bbox)
            height = _bbox_height(bbox)
            font_size = float(block.get("fontSize") or 0.0)
            block_type = str(block.get("blockType") or "")
            tall_narrow = width <= max(font_size * 2.0, 20.0) and height >= max(width * 2.5, 40.0)
            tableish_neighbor = block_type in {"table_body", "metadata"} and height >= 40.0
            overlap = max(0.0, min(union_bbox[3], bbox[3]) - max(union_bbox[1], bbox[1]))
            overlap_ratio = overlap / max(min(_bbox_height(union_bbox), _bbox_height(bbox)), 1.0)
            horizontal_gap = min(abs(bbox[0] - union_bbox[2]), abs(union_bbox[0] - bbox[2]))
            intersects_x = bbox[0] <= union_bbox[2] and bbox[2] >= union_bbox[0]
            if not (tall_narrow or tableish_neighbor):
                continue
            if overlap_ratio < 0.72:
                continue
            if not intersects_x and horizontal_gap > 70.0:
                continue
            candidates.append(block)
            candidate_ids.add(block_id)
            union_bbox = _union_bboxes([union_bbox, bbox]) or union_bbox
            changed = True
    return candidates


def _select_rotated_table_region(
    page_blocks: List[Dict[str, Any]],
    page_width: float,
    page_height: float,
) -> Optional[List[float]]:
    candidates = _collect_rotated_table_region_blocks(page_blocks)
    if not candidates:
        return None
    body_blocks = [
        block
        for block in candidates
        if str(block.get("blockType") or "") in {"table_body", "metadata"}
    ]
    region_bbox = _union_bboxes([_bbox(block) for block in body_blocks if _bbox(block) is not None])
    if region_bbox is None:
        region_bbox = _union_bboxes([_bbox(block) for block in candidates if _bbox(block) is not None])
    if region_bbox is None:
        return None
    x0, y0, x1, y1 = region_bbox
    pad_x = min(max(page_width * 0.02, 12.0), 28.0)
    pad_y = min(max(page_height * 0.01, 8.0), 20.0)
    return [
        max(0.0, x0 - pad_x),
        max(0.0, y0 - pad_y),
        min(page_width, x1 + pad_x),
        min(page_height, y1 + pad_y),
    ]


def _build_rotated_page_coarse_table(page_no: int, page_blocks: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    candidates = _collect_rotated_table_region_blocks(page_blocks)
    if not candidates:
        return None

    explicit_caption_blocks = [
        block
        for block in candidates
        if str(block.get("text") or "").strip().lower().startswith("table")
    ]
    body_blocks = [
        block
        for block in candidates
        if str(block.get("blockType") or "") in {"table_body", "metadata"}
    ]
    body_bbox = _union_bboxes([_bbox(block) for block in body_blocks if _bbox(block) is not None]) or union_bbox

    caption_blocks = list(explicit_caption_blocks)
    for block in page_blocks:
        block_id = str(block.get("id") or "")
        if block in body_blocks:
            continue
        if str(block.get("blockType") or "") != "heading":
            continue
        bbox = _bbox(block)
        if bbox is None:
            continue
        text = str(block.get("text") or "").strip()
        if not text or "Author Manuscript" in text or "Page " in text:
            continue
        overlap = max(0.0, min(body_bbox[3], bbox[3]) - max(body_bbox[1], bbox[1]))
        overlap_ratio = overlap / max(min(_bbox_height(body_bbox), _bbox_height(bbox)), 1.0)
        if overlap_ratio < 0.55:
            continue
        gap = body_bbox[0] - bbox[2]
        if gap < -4.0 or gap > 40.0:
            continue
        caption_blocks.append(block)

    deduped_caption_blocks: List[Dict[str, Any]] = []
    seen_caption_ids: set[str] = set()
    for block in caption_blocks:
        block_id = str(block.get("id") or "")
        if block_id in seen_caption_ids:
            continue
        seen_caption_ids.add(block_id)
        deduped_caption_blocks.append(block)
    caption_blocks = deduped_caption_blocks
    caption_ids = [str(block.get("id") or "") for block in caption_blocks]
    display_bbox = _union_bboxes(
        [body_bbox] + [_bbox(block) for block in caption_blocks if _bbox(block) is not None]
    ) or body_bbox
    return {
        "id": f"p{page_no}_t1",
        "bbox": body_bbox,
        "displayBBox": display_bbox,
        "bodyBlockIds": [str(block.get("id") or "") for block in candidates if block.get("blockType") in {"table_body", "metadata"}],
        "headerBlockIds": [],
        "captionBlockIds": caption_ids,
        "bodyTexts": [str(block.get("text") or "") for block in candidates if block.get("blockType") in {"table_body", "metadata"}],
        "headerTexts": [],
        "captionTexts": [str(block.get("text") or "") for block in caption_blocks],
    }


def _normalize_rotated_blocks(
    page_blocks: List[Dict[str, Any]],
    region_bbox: List[float],
    rotation: int,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    transform = _build_region_rotation_transform(region_bbox, rotation)
    normalized_blocks: List[Dict[str, Any]] = []
    for block in page_blocks:
        normalized = json.loads(json.dumps(block, ensure_ascii=False))
        normalized["sourceBlockId"] = str(block.get("id") or "")
        normalized["rotation"] = rotation
        bbox = _bbox(block)
        if bbox is not None:
            normalized["bbox"] = _transform_bbox(bbox, transform["matrix"])
        for line in normalized.get("layoutLines") or []:
            line_bbox = line.get("bbox") or []
            if len(line_bbox) == 4:
                line["bbox"] = _transform_bbox([float(v) for v in line_bbox], transform["matrix"])
            for item in line.get("items") or []:
                item_bbox = item.get("bbox") or []
                if len(item_bbox) == 4:
                    item["bbox"] = _transform_bbox([float(v) for v in item_bbox], transform["matrix"])
        normalized["pageWidth"] = transform["normalizedWidth"]
        normalized["pageHeight"] = transform["normalizedHeight"]
        normalized_blocks.append(normalized)
    return normalized_blocks, transform


def _normalize_rotated_lines(
    page_lines: List[List[float]],
    transform: Dict[str, Any],
) -> List[List[float]]:
    normalized = [_transform_bbox(line, transform["matrix"]) for line in page_lines]
    normalized.sort(key=lambda line: (line[1], line[0]))
    return normalized


def _map_detected_table_back(table: Dict[str, Any], transform: Dict[str, Any]) -> Dict[str, Any]:
    mapped = dict(table)
    bbox = table.get("bbox") or []
    display_bbox = table.get("displayBBox") or []
    if len(bbox) == 4:
        mapped["bbox"] = _transform_bbox([float(v) for v in bbox], transform["inverseMatrix"])
    if len(display_bbox) == 4:
        mapped["displayBBox"] = _transform_bbox([float(v) for v in display_bbox], transform["inverseMatrix"])
    return mapped


def _detect_table_on_normalized_region(
    page_no: int,
    normalized_blocks: List[Dict[str, Any]],
    normalized_lines: List[List[float]],
    merge_gap: float = 34.0,
) -> Dict[str, Any]:
    return _detect_page_tables(page_no, normalized_blocks, normalized_lines, merge_gap=merge_gap)


def _detect_page_tables(
    page_no: int,
    page_blocks: List[Dict[str, Any]],
    page_lines: List[List[float]],
    merge_gap: float = 34.0,
) -> Dict[str, Any]:
    page_width = 0.0
    if page_blocks:
        page_width = float(page_blocks[0].get("pageWidth") or 0.0)

    table_bodies = [block for block in page_blocks if _is_table_seed_candidate(block, page_width)]
    page_tables: List[Dict[str, Any]] = []
    seen_body_sets: set[Tuple[str, ...]] = set()
    page_header_ids: set[str] = set()
    used_block_ids: set[str] = set()
    table_index = 1

    for region in _build_rule_regions(page_lines, page_width):
        for subregion in _split_rule_region_by_captions(region, page_blocks):
            cluster = _collect_blocks_for_rule_region(page_blocks, subregion["bbox"])
            if not _looks_like_rule_region_table(cluster):
                continue
            body_ids = tuple(sorted(str(block.get("id") or "") for block in cluster))
            if not body_ids or body_ids in seen_body_sets:
                continue
            seen_body_sets.add(body_ids)
            used_block_ids.update(body_ids)

            cluster_bbox = _union_bboxes([_bbox(block) for block in cluster if _bbox(block) is not None]) or subregion["bbox"]
            assigned_captions: List[Dict[str, Any]] = []
            for block in page_blocks:
                if not _is_table_caption_block(block):
                    continue
                caption_bbox = _bbox(block)
                if caption_bbox is None:
                    continue
                overlap = _horizontal_overlap(caption_bbox, cluster_bbox)
                overlap_ratio = overlap / max(min(_bbox_width(caption_bbox), _bbox_width(cluster_bbox)), 1.0)
                gap = _vertical_gap(caption_bbox, cluster_bbox)
                if overlap_ratio < 0.50:
                    continue
                if gap < -6.0 or gap > 72.0:
                    continue
                assigned_captions.append(block)
                used_block_ids.add(str(block.get("id") or ""))

            raw_body_bbox = _union_bboxes([cluster_bbox, subregion["bbox"]]) or cluster_bbox
            body_bbox = _refine_bbox_with_horizontal_rules(raw_body_bbox, page_lines)
            if assigned_captions:
                body_bbox[1] = max(float(body_bbox[1]), float(raw_body_bbox[1]))
            display_boxes = [body_bbox]
            display_boxes.extend(
                caption_bbox
                for caption_bbox in (_bbox(block) for block in assigned_captions)
                if caption_bbox is not None
            )
            display_bbox = _union_bboxes(display_boxes) or body_bbox

            page_tables.append(
                {
                    "id": f"p{page_no}_t{table_index}",
                    "kind": "table",
                    "bbox": body_bbox,
                    "displayBBox": display_bbox,
                    "bodyBlockIds": list(body_ids),
                    "headerBlockIds": [],
                    "captionBlockIds": [str(block.get("id") or "") for block in assigned_captions],
                    "bodyTexts": [str(block.get("text") or "") for block in cluster],
                    "headerTexts": [],
                    "captionTexts": [str(block.get("text") or "") for block in assigned_captions],
                }
            )
            table_index += 1

    clusters = _cluster_table_blocks(table_bodies)
    for cluster in clusters:
        cluster = _expand_cluster(cluster, page_blocks, page_width)
        cluster_boxes = [_bbox(block) for block in cluster]
        cluster_bbox = _union_bboxes([box for box in cluster_boxes if box is not None])
        if cluster_bbox is None or len(cluster) < 2:
            continue
        body_ids = tuple(sorted(str(block.get("id") or "") for block in cluster))
        if body_ids in seen_body_sets:
            continue
        seen_body_sets.add(body_ids)
        used_block_ids.update(body_ids)

        assigned_headers = _find_cluster_headers(page_blocks, cluster_bbox, page_width)
        for header in assigned_headers:
            page_header_ids.add(str(header.get("id") or ""))
            used_block_ids.add(str(header.get("id") or ""))

        assigned_captions: List[Dict[str, Any]] = []
        for block in page_blocks:
            if not _is_table_caption_block(block):
                continue
            caption_bbox = _bbox(block)
            if caption_bbox is None:
                continue
            overlap = _horizontal_overlap(caption_bbox, cluster_bbox)
            overlap_ratio = overlap / max(min(_bbox_width(caption_bbox), _bbox_width(cluster_bbox)), 1.0)
            gap = _vertical_gap(caption_bbox, cluster_bbox)
            if overlap_ratio < 0.50:
                continue
            if gap < -6.0 or gap > 72.0:
                continue
            assigned_captions.append(block)
            used_block_ids.add(str(block.get("id") or ""))

        if not assigned_captions and _looks_like_figure_label_cluster(cluster, cluster_bbox):
            seen_body_sets.discard(body_ids)
            used_block_ids.difference_update(body_ids)
            continue

        body_display_boxes = [box for box in cluster_boxes if box is not None]
        body_display_boxes.extend(
            header_bbox
            for header_bbox in (_bbox(block) for block in assigned_headers)
            if header_bbox is not None
        )
        raw_body_bbox = _union_bboxes(body_display_boxes) or cluster_bbox
        body_bbox = _refine_bbox_with_horizontal_rules(raw_body_bbox, page_lines)
        if assigned_captions:
            body_bbox[1] = max(float(body_bbox[1]), float(raw_body_bbox[1]))

        display_boxes = list(body_display_boxes)
        display_boxes.extend(
            caption_bbox
            for caption_bbox in (_bbox(block) for block in assigned_captions)
            if caption_bbox is not None
        )
        display_bbox = _union_bboxes(display_boxes) or cluster_bbox
        display_bbox = _union_bboxes([body_bbox, display_bbox]) or display_bbox

        page_tables.append(
            {
                "id": f"p{page_no}_t{table_index}",
                "kind": "table",
                "bbox": body_bbox,
                "displayBBox": display_bbox,
                "bodyBlockIds": list(body_ids),
                "headerBlockIds": [str(block.get("id") or "") for block in assigned_headers],
                "captionBlockIds": [str(block.get("id") or "") for block in assigned_captions],
                "bodyTexts": [str(block.get("text") or "") for block in cluster],
                "headerTexts": [str(block.get("text") or "") for block in assigned_headers],
                "captionTexts": [str(block.get("text") or "") for block in assigned_captions],
            }
        )
        table_index += 1

    single_body_tables = _find_single_body_tables(page_blocks, page_width, used_block_ids)
    for table in single_body_tables:
        table["kind"] = "table"
        page_tables.append(table)
        body_ids = tuple(sorted(table.get("bodyBlockIds") or []))
        if body_ids:
            seen_body_sets.add(body_ids)
        for header_id in table.get("headerBlockIds") or []:
            page_header_ids.add(str(header_id))

    page_tables = _dedupe_tables(page_tables)
    page_tables = _merge_adjacent_tables(page_tables, page_blocks, max_gap=merge_gap)
    algorithm_structures = _find_algorithm_structures(page_no, page_blocks, page_width, used_block_ids)
    page_structures = sorted(
        list(page_tables) + algorithm_structures,
        key=lambda structure: (
            float((structure.get("bbox") or [0.0, 0.0, 0.0, 0.0])[1]),
            float((structure.get("bbox") or [0.0, 0.0, 0.0, 0.0])[0]),
        ),
    )
    return {
        "page": page_no,
        "tableBodyCandidateCount": len(table_bodies),
        "tableHeaderCandidateCount": len(page_header_ids),
        "tables": page_tables,
        "structures": page_structures,
    }


def detect_tables(data: Dict[str, Any]) -> Dict[str, Any]:
    blocks = _iter_blocks(data)
    page_groups = _group_blocks_by_page(blocks)
    page_line_hints: Dict[int, List[List[float]]] = data.get("_pageLineHints") or {}
    result_pages: List[Dict[str, Any]] = []

    for page_no in sorted(page_groups):
        page_blocks = page_groups[page_no]
        page_lines = page_line_hints.get(page_no, [])
        page_result = _detect_page_tables(page_no, page_blocks, page_lines)

        if not (page_result.get("tables") or []) and _page_looks_rotated(page_blocks):
            page_width = float(page_blocks[0].get("pageWidth") or 0.0) if page_blocks else 0.0
            page_height = float(page_blocks[0].get("pageHeight") or 0.0) if page_blocks else 0.0
            region_bbox = _select_rotated_table_region(page_blocks, page_width, page_height)
            if region_bbox is None:
                region_bbox = [0.0, 0.0, page_width, page_height]
            region_blocks = []
            for block in page_blocks:
                bbox = _bbox(block)
                if bbox is None:
                    continue
                overlap = _horizontal_overlap(bbox, region_bbox)
                vertical_overlap = max(0.0, min(bbox[3], region_bbox[3]) - max(bbox[1], region_bbox[1]))
                if overlap <= 0.0 or vertical_overlap <= 0.0:
                    continue
                region_blocks.append(block)
            normalized_blocks, transform = _normalize_rotated_blocks(region_blocks, region_bbox, rotation=90)
            normalized_lines = _normalize_rotated_lines(page_lines, transform)
            rotated_result = _detect_table_on_normalized_region(
                page_no,
                normalized_blocks,
                normalized_lines,
                merge_gap=120.0,
            )
            mapped_tables = [
                _map_detected_table_back(table, transform)
                for table in (rotated_result.get("tables") or [])
            ]
            coarse_table = _build_rotated_page_coarse_table(page_no, page_blocks)
            if coarse_table:
                coarse_table["kind"] = "table"
                page_result = {
                    "page": page_no,
                    "tableBodyCandidateCount": rotated_result.get("tableBodyCandidateCount", 0),
                    "tableHeaderCandidateCount": rotated_result.get("tableHeaderCandidateCount", 0),
                    "tables": [coarse_table],
                    "structures": [coarse_table],
                }
            elif mapped_tables:
                for table in mapped_tables:
                    table["kind"] = "table"
                page_result = {
                    "page": page_no,
                    "tableBodyCandidateCount": rotated_result.get("tableBodyCandidateCount", 0),
                    "tableHeaderCandidateCount": rotated_result.get("tableHeaderCandidateCount", 0),
                    "tables": mapped_tables,
                    "structures": mapped_tables,
                }
            elif coarse_table:
                coarse_table["kind"] = "table"
                page_result = {
                    "page": page_no,
                    "tableBodyCandidateCount": 0,
                    "tableHeaderCandidateCount": 0,
                    "tables": [coarse_table],
                    "structures": [coarse_table],
                }

        if (
            page_result.get("tableBodyCandidateCount")
            or page_result.get("tableHeaderCandidateCount")
            or page_result.get("tables")
            or page_result.get("structures")
        ):
            result_pages.append(page_result)

    return {
        "sourceFile": data.get("sourceFile"),
        "title": data.get("title"),
        "pageCount": len({int(block.get('page') or 0) for block in blocks if block.get('page') is not None}),
        "pages": result_pages,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Detect table regions from a PDF or pdf_blocks.json")
    parser.add_argument("input_path", help="Input PDF or extracted pdf_blocks.json")
    parser.add_argument("output_json", help="Output table detection JSON")
    parser.add_argument("--pages", type=parse_pages, default=None, help="Optional page selection when input is a PDF")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    input_path = Path(args.input_path)
    data, temp_extract_json = _load_blocks(input_path, args.pages)
    try:
        result = detect_tables(data)
    finally:
        if temp_extract_json is not None:
            temp_extract_json.unlink(missing_ok=True)

    output_path = Path(args.output_json)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    table_count = sum(len(page.get("tables") or []) for page in result.get("pages") or [])
    structure_count = sum(len(page.get("structures") or []) for page in result.get("pages") or [])
    print(
        f"Detected structures: {structure_count} (tables={table_count}) "
        f"(pages_with_candidates={len(result.get('pages') or [])}) -> {output_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
