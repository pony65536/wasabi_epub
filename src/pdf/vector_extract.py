# pdf_layer_rebuild.py
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import fitz  # PyMuPDF


@dataclass
class RebuildStats:
    pages: int = 0
    drawings: int = 0
    images: int = 0
    image_placements: int = 0
    images_with_smask: int = 0
    links: int = 0
    skipped_drawings: int = 0
    skipped_images: int = 0


@dataclass
class RebuildOptions:
    rebuild_vectors: bool = True
    rebuild_images: bool = True
    rebuild_links: bool = True
    min_drawing_area: float = 0.0
    verbose: bool = True


def _safe_dashes(value) -> str:
    return value if isinstance(value, str) else "[] 0"


def _safe_int(value, default: int = 0) -> int:
    return value if isinstance(value, int) else default


def _safe_line_cap(value) -> int:
    if isinstance(value, (list, tuple)) and value:
        return max(int(v) for v in value if isinstance(v, int))
    if isinstance(value, int):
        return value
    return 0


def _safe_width(value) -> float:
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    return 1.0


def _safe_bool(value, default: bool = False) -> bool:
    return value if isinstance(value, bool) else default


def _safe_opacity(d: dict, key: str) -> float:
    value = d.get(key)
    if isinstance(value, (int, float)):
        return float(value)

    fallback = d.get("opacity")
    if isinstance(fallback, (int, float)):
        return float(fallback)

    return 1.0


def _extract_image_stream(
    src_doc: fitz.Document,
    xref: int,
    smask_xref: int = 0,
) -> bytes | None:
    try:
        if smask_xref and smask_xref > 0:
            base = fitz.Pixmap(src_doc, xref)
            mask = fitz.Pixmap(src_doc, smask_xref)
            try:
                merged = fitz.Pixmap(base, mask)
                try:
                    return merged.tobytes("png")
                finally:
                    merged = None
            finally:
                mask = None
                base = None

        extracted = src_doc.extract_image(xref)
        image_bytes = extracted.get("image")
        return image_bytes if image_bytes else None
    except Exception:
        return None


def rebuild_vectors(
    src_page: fitz.Page,
    dst_page: fitz.Page,
    *,
    min_area: float = 0.0,
) -> tuple[int, int]:
    """
    Rebuild vector drawings from one source page onto one destination page.

    Returns:
        (rebuilt_count, skipped_count)
    """
    rebuilt = 0
    skipped = 0

    for drawing in src_page.get_drawings():
        rect = drawing.get("rect")
        if rect is not None and rect.width * rect.height < min_area:
            skipped += 1
            continue

        shape = dst_page.new_shape()
        has_path = False

        for item in drawing.get("items", []):
            if not item:
                continue

            op = item[0]

            try:
                if op == "l":
                    shape.draw_line(item[1], item[2])
                    has_path = True

                elif op == "re":
                    shape.draw_rect(item[1])
                    has_path = True

                elif op == "qu":
                    shape.draw_quad(item[1])
                    has_path = True

                elif op == "c":
                    shape.draw_bezier(item[1], item[2], item[3], item[4])
                    has_path = True

                else:
                    skipped += 1

            except Exception:
                skipped += 1

        if not has_path:
            skipped += 1
            continue

        try:
            shape.finish(
                color=drawing.get("color"),
                fill=drawing.get("fill"),
                dashes=_safe_dashes(drawing.get("dashes")),
                lineJoin=_safe_int(drawing.get("lineJoin"), 0),
                lineCap=_safe_line_cap(drawing.get("lineCap")),
                width=_safe_width(drawing.get("width")),
                closePath=_safe_bool(drawing.get("closePath"), False),
                even_odd=_safe_bool(drawing.get("even_odd"), False),
                stroke_opacity=_safe_opacity(drawing, "stroke_opacity"),
                fill_opacity=_safe_opacity(drawing, "fill_opacity"),
            )
            shape.commit()
            rebuilt += 1

        except Exception:
            skipped += 1

    return rebuilt, skipped


def rebuild_images(
    src_page: fitz.Page,
    dst_page: fitz.Page,
    image_xref_cache: Optional[dict[tuple[int, int], int]] = None,
) -> tuple[int, int, int, int]:
    """
    Rebuild bitmap images from one source page onto one destination page.

    Returns:
        (unique_images, placements, skipped, images_with_smask)
    """
    unique_images = 0
    placements = 0
    skipped = 0
    images_with_smask = 0
    seen_xrefs: set[int] = set()
    image_xref_cache = image_xref_cache or {}

    for img in src_page.get_images(full=True):
        xref = img[0]
        smask_xref = int(img[1]) if len(img) > 1 and isinstance(img[1], int) else 0

        if xref in seen_xrefs:
            continue
        seen_xrefs.add(xref)

        image_bytes = _extract_image_stream(src_page.parent, xref, smask_xref)
        if not image_bytes:
            skipped += 1
            continue
        if smask_xref > 0:
            images_with_smask += 1

        try:
            rect_infos = src_page.get_image_rects(xref, transform=True)
        except Exception:
            skipped += 1
            continue

        if not rect_infos:
            skipped += 1
            continue

        unique_images += 1

        for item in rect_infos:
            if isinstance(item, (list, tuple)):
                rect = item[0]
            else:
                rect = item

            try:
                cache_key = (xref, smask_xref)
                cached_dst_xref = image_xref_cache.get(cache_key)
                if cached_dst_xref:
                    dst_page.insert_image(
                        rect,
                        xref=cached_dst_xref,
                        keep_proportion=False,
                        overlay=True,
                    )
                else:
                    new_xref = dst_page.insert_image(
                        rect,
                        stream=image_bytes,
                        keep_proportion=False,
                        overlay=True,
                    )
                    if isinstance(new_xref, int) and new_xref > 0:
                        image_xref_cache[cache_key] = new_xref
                placements += 1
            except Exception:
                skipped += 1

    return unique_images, placements, skipped, images_with_smask


def rebuild_links(src_page: fitz.Page, dst_page: fitz.Page) -> int:
    """
    Copy link annotations from source page to destination page.
    """
    copied = 0

    try:
        links = src_page.get_links()
    except Exception:
        return 0

    for link in links:
        link_copy = dict(link)
        link_copy.pop("xref", None)
        link_copy.pop("id", None)

        if link_copy.get("from") is not None:
            link_copy["from"] = fitz.Rect(link_copy["from"])

        try:
            dst_page.insert_link(link_copy)
            copied += 1
        except Exception:
            pass

    return copied


def rebuild_page_layers(
    src_page: fitz.Page,
    dst_page: fitz.Page,
    options: RebuildOptions,
    image_xref_cache: Optional[dict[tuple[int, int], int]] = None,
) -> RebuildStats:
    stats = RebuildStats(pages=1)

    if options.rebuild_vectors:
        drawings, skipped = rebuild_vectors(
            src_page,
            dst_page,
            min_area=options.min_drawing_area,
        )
        stats.drawings += drawings
        stats.skipped_drawings += skipped

    if options.rebuild_images:
        images, placements, skipped, smask_count = rebuild_images(
            src_page,
            dst_page,
            image_xref_cache=image_xref_cache,
        )
        stats.images += images
        stats.image_placements += placements
        stats.images_with_smask += smask_count
        stats.skipped_images += skipped

    if options.rebuild_links:
        stats.links += rebuild_links(src_page, dst_page)

    return stats


def rebuild_pdf_graphic_layers(
    input_pdf: str | Path,
    output_pdf: str | Path,
    *,
    pages: Optional[Iterable[int]] = None,
    options: Optional[RebuildOptions] = None,
    render_text_callback=None,
) -> RebuildStats:
    """
    Build a new PDF containing rebuilt vector/image layers.

    pages:
        0-based page indexes. None = all pages.

    render_text_callback:
        Optional hook:
            render_text_callback(src_page, dst_page, page_index)

        Put your translated text / formula islands / captions here.
    """
    input_pdf = Path(input_pdf)
    output_pdf = Path(output_pdf)
    options = options or RebuildOptions()

    selected_pages = set(pages) if pages is not None else None
    total = RebuildStats()
    image_xref_cache: dict[tuple[int, int], int] = {}

    src = fitz.open(input_pdf)
    out = fitz.open()

    try:
        for page_index, src_page in enumerate(src):
            if selected_pages is not None and page_index not in selected_pages:
                continue

            dst_page = out.new_page(
                width=src_page.rect.width,
                height=src_page.rect.height,
            )

            page_stats = rebuild_page_layers(
                src_page,
                dst_page,
                options,
                image_xref_cache=image_xref_cache,
            )

            if render_text_callback is not None:
                render_text_callback(src_page, dst_page, page_index)

            total.pages += page_stats.pages
            total.drawings += page_stats.drawings
            total.images += page_stats.images
            total.image_placements += page_stats.image_placements
            total.images_with_smask += page_stats.images_with_smask
            total.links += page_stats.links
            total.skipped_drawings += page_stats.skipped_drawings
            total.skipped_images += page_stats.skipped_images

            if options.verbose:
                print(
                    f"page {page_index}: "
                    f"drawings={page_stats.drawings}, "
                    f"images={page_stats.images}, "
                    f"placements={page_stats.image_placements}, "
                    f"smask_images={page_stats.images_with_smask}, "
                    f"links={page_stats.links}, "
                    f"skipped_drawings={page_stats.skipped_drawings}, "
                    f"skipped_images={page_stats.skipped_images}"
                )

        output_pdf.parent.mkdir(parents=True, exist_ok=True)
        out.save(output_pdf, garbage=4, deflate=True)

    finally:
        out.close()
        src.close()

    if options.verbose:
        print("saved:", output_pdf)
        print(total)

    return total


if __name__ == "__main__":
    rebuild_pdf_graphic_layers(
        input_pdf="1706.03762v7.pdf",
        output_pdf="1706.03762v7_graphic_layers.pdf",
        options=RebuildOptions(
            rebuild_vectors=True,
            rebuild_images=True,
            rebuild_links=True,
            min_drawing_area=0,
            verbose=True,
        ),
    )
