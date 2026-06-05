from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set

from domain import core


def detect_preserved_figure_block_ids(
    page_blocks: List[Dict[str, Any]],
    page_width: float,
    page_height: float,
) -> Set[str]:
    preserved_ids: Set[str] = set()
    figure_captions = [block for block in page_blocks if core.is_figure_caption(block["text"])]
    if not figure_captions:
        return preserved_ids

    for caption in figure_captions:
        cx0, cy0, cx1, _ = caption["bbox"]
        region = [
            max(0.0, cx0 - 40),
            max(0.0, cy0 - min(page_height * 0.28, 220)),
            min(page_width, cx1 + 40),
            max(0.0, cy0 - 4),
        ]
        candidates = [
            block
            for block in page_blocks
            if block["id"] != caption["id"]
            and core.bbox_intersects(block["bbox"], region)
            and core.overlaps_region_x(block, cx0, cx1, margin=48)
            and block["bbox"][3] <= cy0 - 2
            and core.is_figure_label_block(block)
        ]
        anchor_candidates = [
            block
            for block in candidates
            if str(block.get("doclingLabel") or "") == "picture"
            or abs(int(block.get("rotation") or 0)) > 0
        ]
        if len(anchor_candidates) < 4:
            continue
        cluster_region = list(anchor_candidates[0]["bbox"])
        for block in anchor_candidates[1:]:
            cluster_region = core.expand_bbox(cluster_region, block["bbox"])

        for block in candidates:
            if not core.bbox_intersects(block["bbox"], core.bbox_with_margin(cluster_region, 16)):
                continue
            preserved_ids.add(block["id"])

    return preserved_ids


def build_layout_table_candidates(
    page_blocks: List[Dict[str, Any]],
    page_width: float,
) -> List[List[float]]:
    candidates: List[List[float]] = []
    relevant = [block for block in page_blocks if core.is_short_or_tableish_block(block)]
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

        candidates.append(core.bbox_with_margin([x0, y0, x1, y1], 4))

    return candidates


def build_table_candidate_regions(
    page,
    page_blocks: List[Dict[str, Any]],
    page_width: float,
) -> List[List[float]]:
    candidates: List[List[float]] = []

    for caption in page_blocks:
        if not core.is_table_caption(caption["text"]):
            continue

        cx0, cy0, cx1, cy1 = caption["bbox"]
        candidate = [max(0, cx0 - 24), cy1 - 2, min(page_width, cx1 + 24), cy1 + 260]

        related_blocks = [
            block
            for block in page_blocks
            if block["id"] != caption["id"]
            and core.overlaps_region_x(block, candidate[0], candidate[2], margin=12)
            and block["bbox"][1] >= cy1 - 6
            and block["bbox"][1] <= cy1 + 260
        ]
        if related_blocks:
            tableish = [block for block in related_blocks if core.is_table_body_block(block)]
            if tableish:
                region = list(tableish[0]["bbox"])
                for block in tableish:
                    region = core.expand_bbox(region, block["bbox"])
                candidates.append(core.bbox_with_margin(region, 4))

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
        candidates.append(core.bbox_with_margin(region, 3))

    candidates.extend(build_layout_table_candidates(page_blocks, page_width))
    return candidates


def score_table_candidate(
    candidate_region: List[float],
    page_blocks: List[Dict[str, Any]],
    horizontal_segments: List[List[float]],
    page_width: float,
) -> float:
    candidate_blocks = core.collect_blocks_in_region(page_blocks, candidate_region)
    if not candidate_blocks:
        return 0.0

    texts = [core.normalize_text(block["text"]) for block in candidate_blocks]
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
    tableish_block_count = sum(1 for text in non_empty_texts if core.is_tableish_block(text))
    caption_count = sum(1 for text in non_empty_texts if core.is_table_caption(text))
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
            if len(core.normalize_text(block["text"])) > 0
        }
    )
    col_positions = sorted(
        {
            round(block["bbox"][0] / 12.0) * 12.0
            for block in candidate_blocks
            if len(core.normalize_text(block["text"])) > 0
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

    width_ratio = (candidate_region[2] - candidate_region[0]) / max(page_width, 1)
    if width_ratio > 0.85 and prose_like_count >= 2:
        score -= 2.5

    return score


def refine_table_region(
    candidate_region: List[float],
    page_blocks: List[Dict[str, Any]],
    horizontal_segments: List[List[float]],
) -> Optional[List[float]]:
    candidate_blocks = core.collect_blocks_in_region(page_blocks, candidate_region)
    supporting_blocks = [block for block in candidate_blocks if core.is_table_body_block(block)]
    if not supporting_blocks:
        return None

    refined = list(supporting_blocks[0]["bbox"])
    for block in supporting_blocks[1:]:
        refined = core.expand_bbox(refined, block["bbox"])

    line_segments = [
        [x0, y, x1]
        for x0, y, x1 in horizontal_segments
        if x1 >= refined[0] - 8
        and x0 <= refined[2] + 8
        and refined[1] - 16 <= y <= refined[3] + 16
    ]
    if line_segments:
        refined = core.expand_bbox(
            refined,
            [
                min(item[0] for item in line_segments),
                min(item[1] for item in line_segments),
                max(item[2] for item in line_segments),
                max(item[1] for item in line_segments),
            ],
        )

    return core.bbox_with_margin(refined, 4)


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
            if core.bbox_intersects(existing, region):
                accepted[index] = core.expand_bbox(existing, region)
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
        if core.is_table_caption(block["text"]):
            candidates.append(block)
    if not candidates:
        return None
    return max(candidates, key=lambda block: block["bbox"][3])


def signature_text(text: str) -> str:
    normalized = core.normalize_text(text).lower()
    normalized = re.sub(r"\d+", "#", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip()


def is_repeated_signature_candidate(text: str) -> bool:
    normalized = core.normalize_text(text)
    if len(normalized) < 3:
        return False
    if len(normalized) > 160:
        return False
    if re.fullmatch(r"[\d\s./-]+", normalized):
        return False
    return True


def is_page_number_block(block: Dict[str, Any]) -> bool:
    text = core.normalize_text(block["text"])
    return bool(re.fullmatch(r"\d{1,3}", text))


def is_journal_footer_metadata_block(block: Dict[str, Any]) -> bool:
    text = core.normalize_text(block.get("text") or "")
    if not text:
        return False
    page_height = max(float(block.get("pageHeight") or 1.0), 1.0)
    y0 = float((block.get("bbox") or [0, 0, 0, 0])[1])
    if y0 < page_height * 0.94:
        return False

    compact = re.sub(r"[^A-Za-z0-9]+", "", text.upper())
    if not compact:
        return False

    has_journal_marker = "NATURE" in compact or "VOL" in compact
    has_date_or_correction = "CORRECTED" in compact or "SEPTEMBER" in compact
    has_page_number = bool(re.search(r"\b\d{1,3}\b", text))
    return has_journal_marker and (has_date_or_correction or has_page_number)


def is_margin_metadata_block(block: Dict[str, Any]) -> bool:
    text = core.normalize_text(block["text"])
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
        and (height_ratio >= 0.14 or is_rotated or len(core.normalize_text(block["text"])) >= 18)
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
            if is_journal_footer_metadata_block(block):
                preserved_ids.add(block["id"])
                continue
            if signature in repeated_side and is_side_marginalia_block(block):
                preserved_ids.add(block["id"])
                continue
            if is_page_number_block(block) and y0 >= page_height * 0.89:
                preserved_ids.add(block["id"])
                continue
            if is_margin_metadata_block(block) and (y1 <= page_height * 0.12 or is_side_marginalia_block(block)):
                preserved_ids.add(block["id"])

    return preserved_ids


def is_running_header_label_text(text: str) -> bool:
    compact = core.normalize_text(text).strip()
    if not compact or len(compact) > 24:
        return False
    if not core.RUNNING_HEADER_LABEL_REGEX.fullmatch(compact):
        return False
    words = [token for token in compact.split(" ") if token]
    return 1 <= len(words) <= 3


def detect_running_header_label_regions(source_doc) -> Dict[int, List[List[float]]]:
    regions_by_page: Dict[int, List[List[float]]] = {}

    for page_index, page in enumerate(source_doc):
        page_width = max(float(page.rect.width), 1.0)
        page_height = max(float(page.rect.height), 1.0)
        header_band = page_height * 0.14
        edge_band = page_width * 0.24
        candidates: List[Dict[str, Any]] = []

        try:
            raw = page.get_text("rawdict")
        except Exception:
            continue

        for block in raw.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = "".join(ch.get("c", "") for ch in span.get("chars", []))
                    compact = core.normalize_text(text)
                    bbox = [float(v) for v in span.get("bbox", [])]
                    if len(bbox) != 4:
                        continue
                    x0, y0, x1, y1 = bbox
                    if y1 > header_band:
                        continue
                    if min(x0, page_width - x1) > edge_band:
                        continue
                    if not is_running_header_label_text(compact):
                        continue
                    side = "left" if x0 <= (page_width - x1) else "right"
                    candidates.append({"bbox": bbox, "text": compact, "side": side})

        clusters: List[Dict[str, Any]] = []
        for candidate in sorted(candidates, key=lambda item: (item["bbox"][1], item["bbox"][0])):
            matched = None
            for cluster in clusters:
                if cluster["side"] != candidate["side"]:
                    continue
                cbbox = cluster["bbox"]
                same_band = abs(candidate["bbox"][1] - cbbox[1]) <= 12.0
                close_x = candidate["bbox"][0] <= cbbox[2] + 24.0 and candidate["bbox"][2] >= cbbox[0] - 24.0
                if same_band and close_x:
                    matched = cluster
                    break
            if matched is None:
                clusters.append({"side": candidate["side"], "bbox": list(candidate["bbox"]), "texts": [candidate["text"]]})
            else:
                matched["bbox"] = core.expand_bbox(matched["bbox"], candidate["bbox"])
                matched["texts"].append(candidate["text"])

        for cluster in clusters:
            if len(cluster["texts"]) >= 2:
                regions_by_page.setdefault(page_index, []).append(core.bbox_with_margin(cluster["bbox"], 4.0))

    return regions_by_page


def build_preserved_peripheral_regions_by_page(
    pages_blocks: List[List[Dict[str, Any]]],
) -> Dict[int, List[List[float]]]:
    regions_by_page: Dict[int, List[List[float]]] = {}

    for page_index, page_blocks in enumerate(pages_blocks):
        top_blocks: List[Dict[str, Any]] = []
        bottom_blocks: List[Dict[str, Any]] = []
        side_blocks: List[Dict[str, Any]] = []

        for block in page_blocks:
            if str(block.get("preserveReason") or "") != "peripheral_repeat":
                continue
            bbox = block.get("bbox") or []
            if len(bbox) != 4:
                continue
            page_height = max(float(block.get("pageHeight") or 1.0), 1.0)
            y0 = float(bbox[1])
            y1 = float(bbox[3])
            if y1 <= page_height * 0.14:
                top_blocks.append(block)
            elif y0 >= page_height * 0.86:
                bottom_blocks.append(block)
            elif is_side_marginalia_block(block):
                side_blocks.append(block)

        def append_group(blocks: List[Dict[str, Any]], margin: float) -> None:
            if not blocks:
                return
            region = core.union_bboxes([list(block["bbox"]) for block in blocks])
            if region is None:
                return
            regions_by_page.setdefault(page_index, []).append(
                core.bbox_with_margin(region, margin)
            )

        append_group(top_blocks, 4.0)
        append_group(bottom_blocks, 4.0)
        append_group(side_blocks, 4.0)

    return regions_by_page


def is_table_body_block(block: Dict[str, Any]) -> bool:
    return core.is_table_body_block(block)
