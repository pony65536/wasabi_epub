# PDF heuristics fixtures

`tests/test_pdf_formula_heuristics.py` reads its inputs from this directory:

- `pdf_blocks_translated.json` — the PDF block JSON previously cached as
  `.cache_2605.08083v1_pdf/pdf_blocks_translated.json`
- `2605.08083v1_tables_from_pdf.json`
- `1706.03762v7_tables.json`
- `Functional_Brain_Mapping_and_Its_Applica_tables_latest.json`
- `nihms-984751_tables_latest.json`

The original files were never committed and are not present in the current
working tree. Keep only the blocks and table pages referenced by the test
(`p2_b2`, `p2_b3`, `p7_b12`, pages 6, 7, 8, 17, 19) to keep the fixture small.

Until these files are added, `npm run test:python` skips the suite with a
`Missing PDF fixtures` reason instead of failing on machine-specific paths.
Missing PyMuPDF (`fitz`) also results in a skip.
