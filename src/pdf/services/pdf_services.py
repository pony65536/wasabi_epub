from __future__ import annotations

from typing import List, Optional

from services.pdf_extract_impl import extract_blocks as _extract_blocks
from services.pdf_fill_impl import (
    fill_pdf_preserving_graphics as _fill_pdf_preserving_graphics,
)
from services.pdf_strip_impl import (
    StripTextStats,
    strip_text_from_pdf as _strip_text_from_pdf,
)


def extract_pdf_blocks(
    input_pdf: str,
    output_json: str,
    pages: Optional[List[int]] = None,
) -> None:
    _extract_blocks(input_pdf, output_json, pages)


def strip_pdf_text(
    input_pdf: str,
    output_pdf: str,
    pages: Optional[List[int]] = None,
) -> StripTextStats:
    return _strip_text_from_pdf(input_pdf, output_pdf, pages)


def fill_translated_pdf(
    input_pdf: str,
    translated_json: str,
    output_pdf: str,
) -> None:
    _fill_pdf_preserving_graphics(input_pdf, translated_json, output_pdf)
