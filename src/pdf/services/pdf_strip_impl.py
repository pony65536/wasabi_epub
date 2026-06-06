from __future__ import annotations

import dataclasses
import numbers
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from domain import common


@dataclasses.dataclass
class StripTextStats:
    pages: int = 0
    streams: int = 0
    removed_text_objects: int = 0
    retained_risky_text_objects: int = 0
    retained_preserved_region_text_objects: int = 0
    retained_form_text_objects: int = 0
    retained_unterminated_text_objects: int = 0
    forms: int = 0


def pdf_object_visit_key(obj: Any) -> Tuple[Any, ...]:
    objgen = getattr(obj, "objgen", None)
    if isinstance(objgen, tuple) and len(objgen) == 2:
        try:
            objnum = int(objgen[0])
            generation = int(objgen[1])
        except Exception:
            objnum = 0
            generation = 0
        if objnum > 0:
            return ("indirect", objnum, generation)
    return ("direct", id(obj))


def get_inherited_resources(obj: Any, fallback: Any = None) -> Any:
    resources = None
    if obj is not None:
        try:
            resources = obj.get("/Resources")
        except Exception:
            resources = None
    return resources if resources is not None else fallback


def get_font_resource(fonts: Any, font_name: Any) -> Any:
    if fonts is None:
        return None
    for candidate in (font_name, str(font_name or "")):
        try:
            font = fonts.get(candidate)
        except Exception:
            font = None
        if font is not None:
            return font
    return None


def text_object_is_risky(
    instructions: List[Any],
    resources: Any,
) -> bool:
    font_resources = None
    try:
        font_resources = resources.get("/Font") if resources is not None else None
    except Exception:
        font_resources = None

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = instruction.operands
        if operator == "Tr" and operands:
            try:
                render_mode = int(operands[0])
            except Exception:
                render_mode = 0
            if render_mode >= 4:
                return True
        if operator == "Tf" and len(operands) >= 1:
            font = get_font_resource(font_resources, operands[0])
            try:
                subtype = str(font.get("/Subtype") or "") if font is not None else ""
            except Exception:
                subtype = ""
            if subtype == "/Type3":
                return True
    return False


def identity_matrix() -> Tuple[float, float, float, float, float, float]:
    return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def multiply_matrices(
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


def apply_matrix_to_point(
    matrix: Tuple[float, float, float, float, float, float],
    x: float,
    y: float,
) -> Tuple[float, float]:
    a, b, c, d, e, f = matrix
    return (
        a * x + c * y + e,
        b * x + d * y + f,
    )


def translation_matrix(tx: float, ty: float) -> Tuple[float, float, float, float, float, float]:
    return (1.0, 0.0, 0.0, 1.0, tx, ty)


def point_hits_regions(
    x: float,
    y: float,
    regions: List[List[float]],
    *,
    x_margin: float = 2.0,
    y_margin: float = 6.0,
) -> bool:
    for region in regions:
        if len(region) != 4:
            continue
        x0, y0, x1, y1 = [float(v) for v in region]
        if x0 - x_margin <= x <= x1 + x_margin and y0 - y_margin <= y <= y1 + y_margin:
            return True
    return False


def normalize_text_signature(value: str) -> str:
    compact = re.sub(r"[^A-Za-z0-9]+", "", str(value or "").upper())
    return compact.strip()


def extract_text_object_text(instructions: List[Any]) -> str:
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
                    if isinstance(item, numbers.Number):
                        continue
                    parts.append(str(item))
            except Exception:
                pass
        else:
            parts.append(str(candidate))
    return "".join(parts)


def text_object_hits_preserve_regions(
    instructions: List[Any],
    preserve_text_regions: List[List[float]],
    *,
    initial_ctm: Optional[Tuple[float, float, float, float, float, float]] = None,
) -> bool:
    if not preserve_text_regions:
        return False

    current_ctm = initial_ctm or identity_matrix()
    text_matrix = identity_matrix()
    line_matrix = identity_matrix()
    leading = 0.0

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = instruction.operands

        if operator == "cm" and len(operands) >= 6:
            try:
                matrix = tuple(float(operands[i]) for i in range(6))
                current_ctm = multiply_matrices(matrix, current_ctm)
            except Exception:
                continue
            continue

        if operator == "BT":
            text_matrix = identity_matrix()
            line_matrix = identity_matrix()
            leading = 0.0
            continue

        if operator == "Tm" and len(operands) >= 6:
            try:
                matrix = tuple(float(operands[i]) for i in range(6))
                text_matrix = matrix
                line_matrix = matrix
            except Exception:
                continue
            continue

        if operator == "Td" and len(operands) >= 2:
            try:
                tx = float(operands[0])
                ty = float(operands[1])
                line_matrix = multiply_matrices(line_matrix, translation_matrix(tx, ty))
                text_matrix = line_matrix
            except Exception:
                continue
            continue

        if operator == "TD" and len(operands) >= 2:
            try:
                tx = float(operands[0])
                ty = float(operands[1])
                leading = -ty
                line_matrix = multiply_matrices(line_matrix, translation_matrix(tx, ty))
                text_matrix = line_matrix
            except Exception:
                continue
            continue

        if operator == "TL" and operands:
            try:
                leading = float(operands[0])
            except Exception:
                pass
            continue

        if operator == "T*":
            line_matrix = multiply_matrices(line_matrix, translation_matrix(0.0, -leading))
            text_matrix = line_matrix
            continue

        if operator in {"'", '"'}:
            line_matrix = multiply_matrices(line_matrix, translation_matrix(0.0, -leading))
            text_matrix = line_matrix
            x, y = apply_matrix_to_point(current_ctm, float(text_matrix[4]), float(text_matrix[5]))
            if point_hits_regions(x, y, preserve_text_regions):
                return True
            continue

        if operator in {"Tj", "TJ"}:
            x, y = apply_matrix_to_point(current_ctm, float(text_matrix[4]), float(text_matrix[5]))
            if point_hits_regions(x, y, preserve_text_regions):
                return True

    return False


def filter_text_instructions(
    instructions: List[Any],
    resources: Any,
    *,
    preserve_risky_text: bool = True,
    preserve_unterminated_text: bool = True,
    preserve_text_regions: Optional[List[List[float]]] = None,
    preserve_text_signatures: Optional[Set[str]] = None,
    preserve_text_object_indexes: Optional[Set[int]] = None,
    preserve_all_text: bool = False,
) -> tuple[List[Any], StripTextStats]:
    filtered: List[Any] = []
    stats = StripTextStats()
    text_object: List[Any] = []
    in_text_object = False
    current_ctm = identity_matrix()
    ctm_stack: List[Tuple[float, float, float, float, float, float]] = []
    text_object_ctm = identity_matrix()
    text_object_index = 0

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
                    current_ctm = multiply_matrices(matrix, current_ctm)
                except Exception:
                    pass

        if operator == "BT":
            if in_text_object and text_object:
                if preserve_unterminated_text:
                    filtered.extend(text_object)
                    stats.retained_unterminated_text_objects += 1
                else:
                    stats.removed_text_objects += 1
                text_object_index += 1
            in_text_object = True
            text_object = [instruction]
            text_object_ctm = current_ctm
            continue

        if not in_text_object:
            filtered.append(instruction)
            continue

        text_object.append(instruction)
        if operator != "ET":
            continue

        text_signature = normalize_text_signature(extract_text_object_text(text_object))

        if preserve_all_text:
            filtered.extend(text_object)
            stats.retained_form_text_objects += 1
        elif preserve_text_object_indexes and text_object_index in preserve_text_object_indexes:
            filtered.extend(text_object)
            stats.retained_preserved_region_text_objects += 1
        elif preserve_text_signatures and text_signature and text_signature in preserve_text_signatures:
            filtered.extend(text_object)
            stats.retained_preserved_region_text_objects += 1
        elif preserve_text_regions and text_object_hits_preserve_regions(
            text_object,
            preserve_text_regions,
            initial_ctm=text_object_ctm,
        ):
            filtered.extend(text_object)
            stats.retained_preserved_region_text_objects += 1
        elif preserve_risky_text and text_object_is_risky(text_object, resources):
            filtered.extend(text_object)
            stats.retained_risky_text_objects += 1
        elif not preserve_risky_text and not preserve_unterminated_text:
            stats.removed_text_objects += 1
        else:
            removable_operators = {
                "BT",
                "ET",
                "Tf",
                "Tj",
                "TJ",
                "'",
                '"',
                "Td",
                "TD",
                "Tm",
                "T*",
                "Tc",
                "Tw",
                "Tz",
                "TL",
                "Tr",
                "Ts",
            }
            preserved_nontext = [
                inst for inst in text_object if str(inst.operator) not in removable_operators
            ]
            filtered.extend(preserved_nontext)
            stats.removed_text_objects += 1
        in_text_object = False
        text_object = []
        text_object_index += 1

    if in_text_object and text_object:
        if not preserve_risky_text and not preserve_unterminated_text:
            stats.removed_text_objects += 1
        elif preserve_unterminated_text:
            filtered.extend(text_object)
            stats.retained_unterminated_text_objects += 1
        else:
            stats.removed_text_objects += 1
        text_object_index += 1

    return filtered, stats


def strip_stream_text_recursive(
    stream_obj: Any,
    resources: Any,
    models: Any,
    visited_streams: Set[Tuple[Any, ...]],
    *,
    preserve_risky_text: bool = True,
    preserve_unterminated_text: bool = True,
    preserve_text_regions: Optional[List[List[float]]] = None,
    preserve_text_signatures: Optional[Set[str]] = None,
    preserve_text_object_refs: Optional[Dict[Tuple[int, int], Set[int]]] = None,
    preserve_xobject_names: Optional[Set[str]] = None,
    preserve_all_text: bool = False,
) -> StripTextStats:
    stream_key = pdf_object_visit_key(stream_obj)
    if stream_key in visited_streams:
        return StripTextStats()
    visited_streams.add(stream_key)

    stats = StripTextStats(streams=1)
    stream_resources = get_inherited_resources(stream_obj, resources)
    try:
        xobjects = stream_resources.get("/XObject") if stream_resources is not None else None
    except Exception:
        xobjects = None
    if xobjects is not None:
        for xobject_name, xobject in xobjects.items():
            try:
                subtype = str(xobject.get("/Subtype") or "")
            except Exception:
                subtype = ""
            if subtype != "/Form":
                continue
            stats.forms += 1
            if preserve_xobject_names and str(xobject_name) in preserve_xobject_names:
                stats.retained_form_text_objects += 1
                continue
            child_stats = strip_stream_text_recursive(
                xobject,
                stream_resources,
                models,
                visited_streams,
                preserve_risky_text=preserve_risky_text,
                preserve_unterminated_text=preserve_unterminated_text,
                preserve_text_regions=preserve_text_regions,
                preserve_text_signatures=preserve_text_signatures,
                preserve_text_object_refs=preserve_text_object_refs,
                preserve_xobject_names=preserve_xobject_names,
                preserve_all_text=bool(preserve_text_regions),
            )
            stats.streams += child_stats.streams
            stats.removed_text_objects += child_stats.removed_text_objects
            stats.retained_risky_text_objects += child_stats.retained_risky_text_objects
            stats.retained_preserved_region_text_objects += child_stats.retained_preserved_region_text_objects
            stats.retained_form_text_objects += child_stats.retained_form_text_objects
            stats.retained_unterminated_text_objects += child_stats.retained_unterminated_text_objects
            stats.forms += child_stats.forms

    instructions = list(models.parse_content_stream(stream_obj))
    filtered_instructions, local_stats = filter_text_instructions(
        instructions,
        stream_resources,
        preserve_risky_text=preserve_risky_text,
        preserve_unterminated_text=preserve_unterminated_text,
        preserve_text_regions=preserve_text_regions,
        preserve_text_signatures=preserve_text_signatures,
        preserve_text_object_indexes=(
            preserve_text_object_refs.get(stream_obj.objgen, set())
            if preserve_text_object_refs and isinstance(getattr(stream_obj, "objgen", None), tuple)
            else None
        ),
        preserve_all_text=preserve_all_text,
    )
    stream_obj.write(models.unparse_content_stream(filtered_instructions))
    stats.removed_text_objects += local_stats.removed_text_objects
    stats.retained_risky_text_objects += local_stats.retained_risky_text_objects
    stats.retained_preserved_region_text_objects += local_stats.retained_preserved_region_text_objects
    stats.retained_form_text_objects += local_stats.retained_form_text_objects
    stats.retained_unterminated_text_objects += local_stats.retained_unterminated_text_objects
    return stats


def strip_text_from_pdf(
    input_pdf: str,
    output_pdf: str,
    pages: Optional[List[int]] = None,
    *,
    preserve_risky_text: bool = True,
    preserve_unterminated_text: bool = True,
    preserve_text_regions_by_page: Optional[List[List[List[float]]]] = None,
    preserve_text_signatures_by_page: Optional[List[Set[str]]] = None,
    preserve_text_object_refs_by_page: Optional[List[Dict[Tuple[int, int], Set[int]]]] = None,
    preserve_xobject_names_by_page: Optional[List[Set[str]]] = None,
) -> StripTextStats:
    pikepdf, models = common.require_pikepdf()
    pdf = pikepdf.Pdf.open(input_pdf)
    visited_streams: Set[Tuple[Any, ...]] = set()
    selected_pages = set(pages or [])
    total = StripTextStats()

    try:
        for page_index, page in enumerate(pdf.pages, start=1):
            if selected_pages and page_index not in selected_pages:
                continue

            if "/Contents" not in page.obj:
                continue

            page.contents_coalesce()
            resources = get_inherited_resources(page.obj, None)
            page_stats = strip_stream_text_recursive(
                page.obj["/Contents"],
                resources,
                models,
                visited_streams,
                preserve_risky_text=preserve_risky_text,
                preserve_unterminated_text=preserve_unterminated_text,
                preserve_text_regions=(
                    preserve_text_regions_by_page[page_index - 1]
                    if preserve_text_regions_by_page is not None
                    and page_index - 1 < len(preserve_text_regions_by_page)
                    else None
                ),
                preserve_text_signatures=(
                    preserve_text_signatures_by_page[page_index - 1]
                    if preserve_text_signatures_by_page is not None
                    and page_index - 1 < len(preserve_text_signatures_by_page)
                    else None
                ),
                preserve_text_object_refs=(
                    preserve_text_object_refs_by_page[page_index - 1]
                    if preserve_text_object_refs_by_page is not None
                    and page_index - 1 < len(preserve_text_object_refs_by_page)
                    else None
                ),
                preserve_xobject_names=(
                    preserve_xobject_names_by_page[page_index - 1]
                    if preserve_xobject_names_by_page is not None
                    and page_index - 1 < len(preserve_xobject_names_by_page)
                    else None
                ),
            )
            total.pages += 1
            total.streams += page_stats.streams
            total.removed_text_objects += page_stats.removed_text_objects
            total.retained_risky_text_objects += page_stats.retained_risky_text_objects
            total.retained_preserved_region_text_objects += page_stats.retained_preserved_region_text_objects
            total.retained_form_text_objects += page_stats.retained_form_text_objects
            total.retained_unterminated_text_objects += page_stats.retained_unterminated_text_objects
            total.forms += page_stats.forms

        Path(output_pdf).parent.mkdir(parents=True, exist_ok=True)
        pdf.save(output_pdf)
    finally:
        pdf.close()

    return total
