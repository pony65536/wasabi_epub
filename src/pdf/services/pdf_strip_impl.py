from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Any, List, Optional, Set, Tuple

from domain import common


@dataclasses.dataclass
class StripTextStats:
    pages: int = 0
    streams: int = 0
    removed_text_objects: int = 0
    retained_risky_text_objects: int = 0
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


def filter_text_instructions(
    instructions: List[Any],
    resources: Any,
    *,
    preserve_risky_text: bool = True,
    preserve_unterminated_text: bool = True,
) -> tuple[List[Any], StripTextStats]:
    filtered: List[Any] = []
    stats = StripTextStats()
    text_object: List[Any] = []
    in_text_object = False

    for instruction in instructions:
        operator = str(instruction.operator)
        if operator == "BT":
            if in_text_object and text_object:
                if preserve_unterminated_text:
                    filtered.extend(text_object)
                    stats.retained_unterminated_text_objects += 1
                else:
                    stats.removed_text_objects += 1
            in_text_object = True
            text_object = [instruction]
            continue

        if not in_text_object:
            filtered.append(instruction)
            continue

        text_object.append(instruction)
        if operator != "ET":
            continue

        if not preserve_risky_text and not preserve_unterminated_text:
            stats.removed_text_objects += 1
            in_text_object = False
            text_object = []
            continue

        if preserve_risky_text and text_object_is_risky(text_object, resources):
            filtered.extend(text_object)
            stats.retained_risky_text_objects += 1
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

    if in_text_object and text_object:
        if not preserve_risky_text and not preserve_unterminated_text:
            stats.removed_text_objects += 1
        elif preserve_unterminated_text:
            filtered.extend(text_object)
            stats.retained_unterminated_text_objects += 1
        else:
            stats.removed_text_objects += 1

    return filtered, stats


def strip_stream_text_recursive(
    stream_obj: Any,
    resources: Any,
    models: Any,
    visited_streams: Set[Tuple[Any, ...]],
    *,
    preserve_risky_text: bool = True,
    preserve_unterminated_text: bool = True,
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
        for _, xobject in xobjects.items():
            try:
                subtype = str(xobject.get("/Subtype") or "")
            except Exception:
                subtype = ""
            if subtype != "/Form":
                continue
            stats.forms += 1
            child_stats = strip_stream_text_recursive(
                xobject,
                stream_resources,
                models,
                visited_streams,
                preserve_risky_text=preserve_risky_text,
                preserve_unterminated_text=preserve_unterminated_text,
            )
            stats.streams += child_stats.streams
            stats.removed_text_objects += child_stats.removed_text_objects
            stats.retained_risky_text_objects += child_stats.retained_risky_text_objects
            stats.retained_unterminated_text_objects += child_stats.retained_unterminated_text_objects
            stats.forms += child_stats.forms

    instructions = list(models.parse_content_stream(stream_obj))
    filtered_instructions, local_stats = filter_text_instructions(
        instructions,
        stream_resources,
        preserve_risky_text=preserve_risky_text,
        preserve_unterminated_text=preserve_unterminated_text,
    )
    stream_obj.write(models.unparse_content_stream(filtered_instructions))
    stats.removed_text_objects += local_stats.removed_text_objects
    stats.retained_risky_text_objects += local_stats.retained_risky_text_objects
    stats.retained_unterminated_text_objects += local_stats.retained_unterminated_text_objects
    return stats


def strip_text_from_pdf(
    input_pdf: str,
    output_pdf: str,
    pages: Optional[List[int]] = None,
    *,
    preserve_risky_text: bool = True,
    preserve_unterminated_text: bool = True,
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
            )
            total.pages += 1
            total.streams += page_stats.streams
            total.removed_text_objects += page_stats.removed_text_objects
            total.retained_risky_text_objects += page_stats.retained_risky_text_objects
            total.retained_unterminated_text_objects += page_stats.retained_unterminated_text_objects
            total.forms += page_stats.forms

        Path(output_pdf).parent.mkdir(parents=True, exist_ok=True)
        pdf.save(output_pdf)
    finally:
        pdf.close()

    return total
