from domain.core import (
    PDF_BLOCKS_SCHEMA_VERSION,
    decode_span_flags,
    detect_geometric_script_offset,
    dominant_font_size,
    has_private_use_garbage,
    is_display_formula_block,
    is_formula_heavy_text,
    is_formula_span,
    merge_span_items,
    normalize_text,
    pdf_int_color_to_rgb,
    representative_font_size,
    require_fitz,
    require_pikepdf,
    sanitize_translated_text,
)
from domain.layout import bbox_overlap_ratio, direction_to_rotation
