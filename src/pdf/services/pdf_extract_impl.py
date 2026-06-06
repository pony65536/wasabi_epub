from __future__ import annotations

import json
import os
import statistics
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from domain import common, layout, preservation


def _identity_matrix() -> Tuple[float, float, float, float, float, float]:
    return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _multiply_matrices(
    left: Tuple[float, float, float, float, float, float],
    right: Tuple[float, float, float, float, float, float],
) -> Tuple[float, float, float, float, float, float]:
    a1, b1, c1, d1, e1, f1 = left
    a2, b2, c2, d2, e2, f2 = right
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _apply_matrix_to_point(
    matrix: Tuple[float, float, float, float, float, float],
    x: float,
    y: float,
) -> Tuple[float, float]:
    a, b, c, d, e, f = matrix
    return (a * x + c * y + e, b * x + d * y + f)


def _transform_bbox(
    bbox: List[float],
    matrix: Tuple[float, float, float, float, float, float],
) -> Optional[List[float]]:
    if len(bbox) != 4:
        return None
    x0, y0, x1, y1 = [float(v) for v in bbox]
    corners = [
        _apply_matrix_to_point(matrix, x0, y0),
        _apply_matrix_to_point(matrix, x1, y0),
        _apply_matrix_to_point(matrix, x0, y1),
        _apply_matrix_to_point(matrix, x1, y1),
    ]
    xs = [point[0] for point in corners]
    ys = [point[1] for point in corners]
    return [min(xs), min(ys), max(xs), max(ys)]


def _pdf_bbox_to_page_bbox(bbox: List[float], page_height: float) -> Optional[List[float]]:
    if len(bbox) != 4:
        return None
    x0, y0, x1, y1 = [float(v) for v in bbox]
    return [x0, page_height - y1, x1, page_height - y0]


def _stream_objgen(stream_obj: Any) -> Optional[Tuple[int, int]]:
    objgen = getattr(stream_obj, "objgen", None)
    if isinstance(objgen, tuple) and len(objgen) == 2:
        try:
            objnum = int(objgen[0])
            generation = int(objgen[1])
        except Exception:
            return None
        if objnum > 0:
            return (objnum, generation)
    return None


def _normalize_text_signature(value: str) -> str:
    return "".join(ch for ch in str(value or "").upper() if ch.isalnum()).strip()


def _extract_text_object_text(instructions: List[Any]) -> str:
    parts: List[str] = []
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = instruction.operands
        if operator == "Tj" and operands:
            parts.append(str(operands[0]))
            continue
        if operator not in {"TJ", "'", '"'} or not operands:
            continue
        candidate = operands[-1] if operator in {"'", '"'} else operands[0]
        if operator == "TJ":
            try:
                for item in candidate:
                    if isinstance(item, (int, float)):
                        continue
                    parts.append(str(item))
            except Exception:
                pass
        else:
            parts.append(str(candidate))
    return "".join(parts)


def _point_hits_block_bbox(point_bbox: List[float], block_bbox: List[float], margin: float = 4.0) -> bool:
    if len(point_bbox) != 4 or len(block_bbox) != 4:
        return False
    x = float(point_bbox[0])
    y = float(point_bbox[1])
    x0, y0, x1, y1 = [float(v) for v in block_bbox]
    return x0 - margin <= x <= x1 + margin and y0 - margin <= y <= y1 + margin


def _detect_page_text_object_anchors(pike_page: Any, models: Any) -> List[Dict[str, Any]]:
    anchors: List[Dict[str, Any]] = []
    page_height = float(pike_page.MediaBox[3]) - float(pike_page.MediaBox[1])

    def walk_stream(
        stream_obj: Any,
        resources: Any,
        initial_ctm: Tuple[float, float, float, float, float, float],
    ) -> None:
        try:
            instructions = list(models.parse_content_stream(stream_obj))
        except Exception:
            return

        current_ctm = initial_ctm
        ctm_stack: List[Tuple[float, float, float, float, float, float]] = []
        in_text_object = False
        text_object: List[Any] = []
        text_object_ctm = current_ctm
        text_object_index = 0

        def finalize_text_object() -> None:
            nonlocal text_object_index
            if not text_object:
                return
            stream_objgen = _stream_objgen(stream_obj)
            if stream_objgen is None:
                text_object_index += 1
                return
            points: List[Tuple[float, float]] = []
            text_matrix = _identity_matrix()
            line_matrix = _identity_matrix()
            leading = 0.0
            object_ctm = text_object_ctm
            for text_instruction in text_object:
                operator = str(text_instruction.operator)
                operands = text_instruction.operands
                if operator == "BT":
                    text_matrix = _identity_matrix()
                    line_matrix = _identity_matrix()
                    leading = 0.0
                    continue
                if operator == "Tm" and len(operands) >= 6:
                    try:
                        matrix = tuple(float(operands[i]) for i in range(6))
                    except Exception:
                        continue
                    text_matrix = matrix
                    line_matrix = matrix
                    continue
                if operator == "Td" and len(operands) >= 2:
                    try:
                        tx = float(operands[0])
                        ty = float(operands[1])
                    except Exception:
                        continue
                    line_matrix = _multiply_matrices(line_matrix, (1.0, 0.0, 0.0, 1.0, tx, ty))
                    text_matrix = line_matrix
                    continue
                if operator == "TD" and len(operands) >= 2:
                    try:
                        tx = float(operands[0])
                        ty = float(operands[1])
                    except Exception:
                        continue
                    leading = -ty
                    line_matrix = _multiply_matrices(line_matrix, (1.0, 0.0, 0.0, 1.0, tx, ty))
                    text_matrix = line_matrix
                    continue
                if operator == "TL" and operands:
                    try:
                        leading = float(operands[0])
                    except Exception:
                        pass
                    continue
                if operator == "T*":
                    line_matrix = _multiply_matrices(line_matrix, (1.0, 0.0, 0.0, 1.0, 0.0, -leading))
                    text_matrix = line_matrix
                    continue
                if operator in {"Tj", "TJ", "'", '"'}:
                    if operator in {"'", '"'}:
                        line_matrix = _multiply_matrices(line_matrix, (1.0, 0.0, 0.0, 1.0, 0.0, -leading))
                        text_matrix = line_matrix
                    x, y = _apply_matrix_to_point(object_ctm, float(text_matrix[4]), float(text_matrix[5]))
                    points.append((x, page_height - y))
            if not points:
                text_object_index += 1
                return
            xs = [point[0] for point in points]
            ys = [point[1] for point in points]
            anchors.append(
                {
                    "streamObjgen": [stream_objgen[0], stream_objgen[1]],
                    "textObjectIndex": text_object_index,
                    "bbox": [min(xs), min(ys), max(xs), max(ys)],
                    "signature": _normalize_text_signature(_extract_text_object_text(text_object)),
                }
            )
            text_object_index += 1

        try:
            xobjects = resources.get("/XObject") if resources is not None else None
        except Exception:
            xobjects = None

        for instruction in instructions:
            operator = str(instruction.operator)
            operands = instruction.operands
            if not in_text_object:
                if operator == "q":
                    ctm_stack.append(current_ctm)
                elif operator == "Q":
                    if ctm_stack:
                        current_ctm = ctm_stack.pop()
                elif operator == "cm" and len(operands) >= 6:
                    try:
                        matrix = tuple(float(operands[i]) for i in range(6))
                        current_ctm = _multiply_matrices(matrix, current_ctm)
                    except Exception:
                        pass
                elif operator == "Do" and operands and xobjects is not None:
                    name = operands[0]
                    try:
                        xobject = xobjects.get(name)
                    except Exception:
                        xobject = None
                    if xobject is not None:
                        try:
                            subtype = str(xobject.get("/Subtype") or "")
                        except Exception:
                            subtype = ""
                        if subtype == "/Form":
                            try:
                                child_resources = xobject.get("/Resources")
                            except Exception:
                                child_resources = None
                            form_matrix_obj = xobject.get("/Matrix") if xobject is not None else None
                            form_matrix = (
                                tuple(float(form_matrix_obj[i]) for i in range(6))
                                if form_matrix_obj is not None and len(form_matrix_obj) >= 6
                                else _identity_matrix()
                            )
                            walk_stream(
                                xobject,
                                child_resources if child_resources is not None else resources,
                                _multiply_matrices(form_matrix, current_ctm),
                            )

            if operator == "BT":
                if in_text_object and text_object:
                    finalize_text_object()
                in_text_object = True
                text_object = [instruction]
                text_object_ctm = current_ctm
                continue

            if not in_text_object:
                continue

            text_object.append(instruction)
            if operator == "ET":
                finalize_text_object()
                in_text_object = False
                text_object = []

        if in_text_object and text_object:
            finalize_text_object()

    try:
        page_resources = pike_page.obj.get("/Resources")
    except Exception:
        page_resources = None
    try:
        page_contents = pike_page.obj.get("/Contents")
    except Exception:
        page_contents = None
    if page_contents is not None:
        walk_stream(page_contents, page_resources, _identity_matrix())
    return anchors


def _detect_page_xobject_anchors(pike_page: Any, models: Any) -> List[Dict[str, Any]]:
    anchors: List[Dict[str, Any]] = []
    page_width = float(pike_page.MediaBox[2]) - float(pike_page.MediaBox[0])
    page_height = float(pike_page.MediaBox[3]) - float(pike_page.MediaBox[1])
    page_area = max(page_width * page_height, 1.0)
    seen: Set[Tuple[str, Tuple[int, int] | None]] = set()

    def walk_stream(stream_obj: Any, resources: Any, initial_ctm: Tuple[float, float, float, float, float, float]) -> None:
        try:
            xobjects = resources.get("/XObject") if resources is not None else None
        except Exception:
            xobjects = None
        if xobjects is None:
            return
        try:
            instructions = list(models.parse_content_stream(stream_obj))
        except Exception:
            return

        current_ctm = initial_ctm
        ctm_stack: List[Tuple[float, float, float, float, float, float]] = []
        for instruction in instructions:
            operator = str(instruction.operator)
            operands = instruction.operands
            if operator == "q":
                ctm_stack.append(current_ctm)
                continue
            if operator == "Q":
                if ctm_stack:
                    current_ctm = ctm_stack.pop()
                continue
            if operator == "cm" and len(operands) >= 6:
                try:
                    matrix = tuple(float(operands[i]) for i in range(6))
                    current_ctm = _multiply_matrices(matrix, current_ctm)
                except Exception:
                    pass
                continue
            if operator != "Do" or not operands:
                continue

            name = operands[0]
            try:
                xobject = xobjects.get(name)
            except Exception:
                xobject = None
            if xobject is None:
                continue
            try:
                subtype = str(xobject.get("/Subtype") or "")
            except Exception:
                subtype = ""

            bbox = None
            nested_ctm = current_ctm
            if subtype == "/Form":
                try:
                    form_bbox_raw = [float(v) for v in xobject.get("/BBox")]
                    form_bbox = [
                        min(form_bbox_raw[0], form_bbox_raw[2]),
                        min(form_bbox_raw[1], form_bbox_raw[3]),
                        max(form_bbox_raw[0], form_bbox_raw[2]),
                        max(form_bbox_raw[1], form_bbox_raw[3]),
                    ]
                    form_matrix_obj = xobject.get("/Matrix")
                    form_matrix = (
                        tuple(float(form_matrix_obj[i]) for i in range(6))
                        if form_matrix_obj is not None and len(form_matrix_obj) >= 6
                        else _identity_matrix()
                    )
                    nested_ctm = _multiply_matrices(form_matrix, current_ctm)
                    bbox = _transform_bbox(form_bbox, nested_ctm)
                except Exception:
                    bbox = None
            elif subtype == "/Image":
                bbox = _transform_bbox([0.0, 0.0, 1.0, 1.0], current_ctm)

            if bbox is not None:
                bbox = _pdf_bbox_to_page_bbox(bbox, page_height)
            if bbox is not None:
                bbox_width = max(float(bbox[2]) - float(bbox[0]), 0.0)
                bbox_height = max(float(bbox[3]) - float(bbox[1]), 0.0)
                bbox_area = bbox_width * bbox_height
                if bbox_area <= page_area * 0.95:
                    objgen = getattr(xobject, "objgen", None)
                    anchor_key = (str(name), objgen if isinstance(objgen, tuple) and len(objgen) == 2 else None)
                    if anchor_key not in seen:
                        anchors.append({"name": str(name), "subtype": subtype, "bbox": bbox})
                        seen.add(anchor_key)

            if subtype == "/Form":
                try:
                    child_resources = xobject.get("/Resources")
                except Exception:
                    child_resources = None
                walk_stream(
                    xobject,
                    child_resources if child_resources is not None else resources,
                    nested_ctm,
                )

    try:
        page_resources = pike_page.obj.get("/Resources")
    except Exception:
        page_resources = None
    walk_stream(pike_page, page_resources, _identity_matrix())
    return anchors


def extract_blocks(
    input_pdf: str,
    output_json: str,
    pages: Optional[List[int]] = None,
) -> None:
    fitz = common.require_fitz()
    pikepdf, models = common.require_pikepdf()
    doc = fitz.open(input_pdf)
    pike_doc = pikepdf.Pdf.open(input_pdf)
    pages_blocks: List[List[Dict[str, Any]]] = []
    page_heights = {
        page_index + 1: float(doc[page_index].rect.height)
        for page_index in range(len(doc))
    }
    docling_items, docling_summary = layout.extract_docling_layout_items(
        input_pdf,
        page_heights,
        pages=pages,
    )
    docling_items_by_page: Dict[int, List[Dict[str, Any]]] = {}
    for item in docling_items:
        docling_items_by_page.setdefault(int(item["page"]), []).append(item)
    matched_docling_blocks = 0
    docling_label_counts: Dict[str, int] = {}

    page_indexes = range(len(doc)) if not pages else [page - 1 for page in pages if page <= len(doc)]
    for page_index in page_indexes:
        page = doc[page_index]
        pike_page = pike_doc.pages[page_index]
        page_dict = page.get_text("dict")
        page_width = float(page.rect.width)
        page_height = float(page.rect.height)
        page_xobject_anchors = _detect_page_xobject_anchors(pike_page, models)
        page_text_object_anchors = _detect_page_text_object_anchors(pike_page, models)
        page_blocks: List[Dict[str, Any]] = []
        for block_index, block in enumerate(page_dict.get("blocks", [])):
            if block.get("type") != 0:
                continue

            lines = []
            layout_lines = []
            max_font_size = 0.0
            span_sizes = []
            rotations = []
            block_flag_values: Set[int] = set()
            block_has_italic = False
            block_has_monospace = False
            block_has_bold = False
            block_has_superscript = False
            block_has_subscript = False
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                line_text = common.normalize_text("".join(span.get("text", "") for span in spans))
                if line_text:
                    lines.append(line_text)
                    rotations.append(common.direction_to_rotation(line.get("dir")))
                line_items = []
                for span in spans:
                    size = float(span.get("size", 0) or 0)
                    max_font_size = max(max_font_size, size)
                    if size > 0:
                        span_sizes.append(size)
                block_font_size = common.dominant_font_size(span_sizes) if span_sizes else 10.0
                for span in spans:
                    span_text = str(span.get("text", "") or "")
                    if not span_text:
                        continue
                    size = float(span.get("size", 0) or 0)
                    span_bbox = [float(v) for v in span.get("bbox", [0, 0, 0, 0])]
                    line_bbox = [float(v) for v in line.get("bbox", [0, 0, 0, 0])]
                    span_flags = int(span.get("flags", 0) or 0)
                    span_flag_hints = common.decode_span_flags(span_flags)
                    geom_offset_hints = common.detect_geometric_script_offset(
                        span_bbox,
                        line_bbox,
                        size,
                        block_font_size,
                    )
                    block_flag_values.add(span_flags)
                    block_has_italic = block_has_italic or span_flag_hints["isItalicLike"]
                    block_has_monospace = block_has_monospace or span_flag_hints["isMonospaceLike"]
                    block_has_bold = block_has_bold or span_flag_hints["isBoldLike"]
                    block_has_superscript = (
                        block_has_superscript
                        or span_flag_hints["isSuperscriptLike"]
                        or geom_offset_hints["geomSuperscriptLike"]
                    )
                    block_has_subscript = (
                        block_has_subscript
                        or geom_offset_hints["geomSubscriptLike"]
                    )
                    line_items.append(
                        {
                            "type": "formula" if common.is_formula_span(span, block_font_size) else "text",
                            "text": span_text,
                            "bbox": span_bbox,
                            "font": str(span.get("font", "") or ""),
                            "size": float(span.get("size", 0) or 0),
                            "color": common.pdf_int_color_to_rgb(span.get("color")),
                            "flags": span_flags,
                            **span_flag_hints,
                            **geom_offset_hints,
                            "isSuperscriptLike": bool(
                                span_flag_hints["isSuperscriptLike"]
                                or geom_offset_hints["geomSuperscriptLike"]
                            ),
                            "isSubscriptLike": bool(geom_offset_hints["geomSubscriptLike"]),
                        }
                    )
                merged_items = common.merge_span_items(line_items)
                if merged_items:
                    layout_lines.append(
                        {
                            "bbox": [float(v) for v in line.get("bbox", [0, 0, 0, 0])],
                            "items": merged_items,
                        }
                    )

            text = common.normalize_text("\n".join(lines))
            if not text:
                continue

            x0, y0, x1, y1 = [float(v) for v in block.get("bbox", [0, 0, 0, 0])]
            page_blocks.append(
                {
                    "id": f"p{page_index + 1}_b{block_index}",
                    "page": page_index + 1,
                    "bbox": [x0, y0, x1, y1],
                    "pageWidth": page_width,
                    "pageHeight": page_height,
                    "fontSize": common.dominant_font_size(span_sizes),
                    "medianFontSize": common.representative_font_size(span_sizes),
                    "maxFontSize": max_font_size or 10,
                    "hasSizeJump": (
                        bool(span_sizes)
                        and max(span_sizes) - min(span_sizes) >= 1.5
                    ),
                    "rotation": max(set(rotations), key=rotations.count) if rotations else 0,
                    "layoutLines": layout_lines,
                    "role": "paragraph",
                    "spanFlags": sorted(block_flag_values),
                    "hasItalicLike": block_has_italic,
                    "hasMonospaceLike": block_has_monospace,
                    "hasBoldLike": block_has_bold,
                    "hasSuperscriptLike": block_has_superscript,
                    "hasSubscriptLike": block_has_subscript,
                    "text": text,
                }
            )

        body_font_candidates = [
            float(block["fontSize"])
            for block in page_blocks
            if 6 <= float(block["fontSize"]) <= 14 and len(common.normalize_text(block["text"])) >= 20
        ]
        page_body_font_size = (
            float(statistics.median(body_font_candidates))
            if body_font_candidates
            else 10.0
        )

        for block in page_blocks:
            matched_docling_item = layout.match_docling_item_to_block(
                block,
                docling_items_by_page.get(page_index + 1, []),
            )
            if matched_docling_item:
                block["doclingLabel"] = matched_docling_item.get("label")
                block["doclingText"] = matched_docling_item.get("text")
                matched_docling_blocks += 1
                label = str(matched_docling_item.get("label") or "unknown")
                docling_label_counts[label] = docling_label_counts.get(label, 0) + 1

        for block in page_blocks:
            if block.get("doclingLabel") in ("title", "section_header"):
                if layout.is_paragraph_like_heading_candidate(block, page_body_font_size):
                    block["role"] = "paragraph"
                    block["_demotedFromHeading"] = True
                    block["_proseHeadingSequence"] = True
                else:
                    block["role"] = "heading"
                    block["fontSize"] = max(float(block["fontSize"]), page_body_font_size + 1.0)
            elif layout.looks_like_heading(block["text"], float(block["fontSize"]), page_body_font_size):
                if not layout.is_paragraph_like_heading_candidate(block, page_body_font_size):
                    block["role"] = "heading"
                    block["fontSize"] = max(float(block["fontSize"]), page_body_font_size + 1.0)

        ordered_page_blocks = sorted(
            page_blocks,
            key=lambda block: (
                float((block.get("bbox") or [0, 0, 0, 0])[1]),
                float((block.get("bbox") or [0, 0, 0, 0])[0]),
            ),
        )
        active_prose_heading = None
        for block in ordered_page_blocks:
            if layout.is_heading_prose_continuation(active_prose_heading, block):
                block["role"] = "paragraph"
                block["_demotedFromHeading"] = True
                block["_proseHeadingSequence"] = True
                active_prose_heading = block
                continue
            if str(block.get("doclingLabel") or "") in {"section_header", "title"} and (
                layout.looks_like_prose_block(block) or bool(block.get("_demotedFromHeading"))
            ):
                block["_proseHeadingSequence"] = True
                active_prose_heading = block
                continue
            active_prose_heading = None

        page_body_width = layout.estimate_page_body_width(page_blocks, page_body_font_size)
        for block in page_blocks:
            if layout.should_demote_heading_block(block, page_body_font_size, page_body_width):
                block["role"] = "paragraph"
                block["blockType"] = "body"
                block["layoutIntent"] = "generic"
                block["_demotedFromHeading"] = True
                block["_proseHeadingSequence"] = True

        for block in page_blocks:
            if block.get("_demotedFromHeading"):
                block["role"] = "paragraph"
                block["blockType"] = "body"
                block["layoutIntent"] = "generic"
            wrap_shape_profile = layout.build_wrap_shape_profile(block)
            block["wrapShape"] = str(wrap_shape_profile.get("wrapShape") or "regular")
            block["wrapLineTemplates"] = list(wrap_shape_profile.get("wrapLineTemplates") or [])
            block["pageBodyFontSize"] = page_body_font_size
            block["pageBodyWidth"] = page_body_width
            block["isBodyLike"] = layout.is_body_like_block(
                block,
                page_body_width,
                page_body_font_size,
            )
            if block.get("_demotedFromHeading"):
                block["isBodyLike"] = True
            block["blockType"] = layout.resolve_block_type(
                block,
                page_body_width,
                page_body_font_size,
            )
            block["layoutIntent"] = layout.resolve_layout_intent(
                block,
                page_body_width,
                page_body_font_size,
            )

        layout.mark_drop_cap_relations(page_blocks, page_body_font_size)

        for block in page_blocks:
            block["preferredTextStyle"] = layout.get_preferred_text_style(
                block,
                layout.get_font_role(block),
                bool(block.get("role") == "heading"),
            )
            block["styleFamilyClass"] = layout.block_style_family_class(
                block,
                layout.get_font_role(block),
            )
            block["defaultStyle"] = layout.build_block_default_style(block)

        page_body_latin_family = layout.dominant_page_body_latin_family(page_blocks)
        for block in page_blocks:
            block["pageBodyLatinFamily"] = page_body_latin_family

        preserved_regions = preservation.detect_scored_table_regions(page, page_blocks, page_width)
        preserved_figure_ids = preservation.detect_preserved_figure_block_ids(
            page_blocks,
            page_width,
            page_height,
        )
        for block in page_blocks:
            if str(block.get("doclingLabel") or "") in ("picture", "chart"):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "picture_region"
                block["blockType"] = "other"
            elif block["id"] in preserved_figure_ids:
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "figure_label"
                block["blockType"] = "other"
            elif any(
                common.bbox_overlap_ratio(block["bbox"], region) >= 0.6
                and preservation.is_table_body_block(block)
                for region in preserved_regions
            ):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "table_region"
                block["blockType"] = "table_body"
            elif common.has_private_use_garbage(block["text"]):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "garbled_text"
                block["blockType"] = "other"
            elif common.is_display_formula_block(block):
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "display_formula"
                block["blockType"] = "formula_display"
            elif common.is_formula_heavy_text(block["text"]):
                if block.get("blockType") != "body":
                    block["preserveOriginal"] = True
                    block["role"] = "preserved"
                    block["preserveReason"] = "formula_heavy"
                    block["blockType"] = "formula_display"
            if block.get("preserveOriginal"):
                matched_xobjects = [
                    anchor
                    for anchor in page_xobject_anchors
                    if layout.bbox_overlap_ratio(block["bbox"], anchor["bbox"]) >= 0.35
                ]
                preserve_anchors = dict(block.get("preserveAnchors") or {})
                if matched_xobjects:
                    preserve_anchors["xobjects"] = matched_xobjects
                if str(block.get("preserveStrategy") or "") == "pdf_object":
                    matched_text_objects = [
                        anchor
                        for anchor in page_text_object_anchors
                        if _point_hits_block_bbox(anchor.get("bbox") or [], block["bbox"])
                    ]
                    block_signature = _normalize_text_signature(block.get("text") or "")
                    if block_signature:
                        signature_matches = [
                            anchor
                            for anchor in page_text_object_anchors
                            if anchor.get("signature")
                            and len(str(anchor["signature"])) >= 6
                            and (
                                anchor["signature"] in block_signature
                                or block_signature in anchor["signature"]
                            )
                        ]
                        for anchor in signature_matches:
                            if anchor not in matched_text_objects:
                                matched_text_objects.append(anchor)
                    if matched_text_objects:
                        preserve_anchors["textObjects"] = matched_text_objects
                if preserve_anchors:
                    block["preserveAnchors"] = preserve_anchors
        pages_blocks.append(page_blocks)

    layout.mark_reference_sections(pages_blocks)

    preserved_peripheral_ids = preservation.detect_preserved_peripheral_block_ids(pages_blocks)
    blocks: List[Dict[str, Any]] = []
    for page_blocks in pages_blocks:
        for block in page_blocks:
            if block.get("blockType") == "reference_block":
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block["preserveReason"] = "reference_block"
            if block["id"] in preserved_peripheral_ids:
                block["preserveOriginal"] = True
                block["role"] = "preserved"
                block.setdefault("preserveReason", "peripheral_repeat")
            blocks.append(block)

    payload = {
        "version": common.PDF_BLOCKS_SCHEMA_VERSION,
        "sourceFile": os.path.basename(input_pdf),
        "title": Path(input_pdf).stem,
        "doclingSummary": {
            **docling_summary,
            "matchedBlocks": matched_docling_blocks,
            "labelCounts": docling_label_counts,
        },
        "blocks": blocks,
    }
    Path(output_json).parent.mkdir(parents=True, exist_ok=True)
    Path(output_json).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    pike_doc.close()
    doc.close()
    if docling_summary.get("enabled"):
        sorted_labels = sorted(
            docling_label_counts.items(),
            key=lambda item: (-item[1], item[0]),
        )
        label_preview = ", ".join(f"{label}={count}" for label, count in sorted_labels[:6]) or "none"
        print(
            "Docling: "
            f"status={docling_summary.get('status')} "
            f"items={docling_summary.get('items', 0)} "
            f"matchedBlocks={matched_docling_blocks} "
            f"batchPages={docling_summary.get('batchPages', 0)} "
            f"batches={docling_summary.get('batches', 0)} "
            f"elapsedMs={docling_summary.get('elapsedMs', 0)} "
            f"labels=[{label_preview}]"
        )
    else:
        print(
            "Docling: "
            f"status={docling_summary.get('status')} "
            f"error={docling_summary.get('error', 'unknown')}"
        )
    print(f"Extracted {len(blocks)} text block(s) to {output_json}")
