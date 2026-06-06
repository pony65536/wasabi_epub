# PDF Module Notes

The PDF workflow is orchestrated by Node, while Python handles extraction, preservation decisions, and translated text back-fill.

## Layered Structure

```text
src/pdf/
  translate_pdf.py        # Stable CLI entry used by pdfBridge.js
  pdfBridge.js            # Node -> Python bridge
  pdfHtml.js              # PDF JSON <-> HTML intermediate layer

  app/
    pdf_cli.py            # CLI argument parsing
    pdf_page_selection.py # --pages parsing

  services/
    pdf_services.py       # Python use-case entry points
    pdf_extract_impl.py   # extract orchestration
    pdf_strip_impl.py     # strip orchestration
    pdf_fill_impl.py      # fill orchestration

  domain/
    common.py             # shared text / geometry / dependency helpers
    layout.py             # extraction, Docling matching, layout/block type decisions
    preservation.py       # table/figure/header/footer/peripheral preservation rules
    rendering.py          # translated text rendering and styling
    core.py               # shared lower-level implementation not yet fully split

  infra/
    vector_extract.py     # low-level PDF capabilities such as graphic layer rebuilding
```

## Dependency Direction

- `translate_pdf.py` -> `app/`
- `app/` -> `services/`
- `services/` -> `domain/`
- `domain/` -> `infra/` or low-level libraries

The goal is one-way layering only: upper layers depend on lower layers, never the other way around.

## Current Responsibility Boundaries

- `app/` handles arguments and command dispatch only, not PDF heuristics.
- `services/` orchestrates use cases only, not low-level heuristics.
- `domain/layout.py` answers “how blocks are detected” and “how layout/block types are classified”.
- `domain/preservation.py` answers “which regions should be preserved as-is”.
- `domain/rendering.py` answers “how translated text is written back into the PDF”.
- `domain/core.py` keeps shared lower-level logic that has not yet been further split and should not keep absorbing more use-case logic.
- The root keeps only `translate_pdf.py` as the stable CLI entry; the rest of the implementation lives in layered subdirectories.

## Regression Checks

Install the PDF Python dependencies:

```powershell
python -m pip install -r src/pdf/requirements.txt
```

Or from the project root:

```powershell
npm run pdf:install
```

After changing `src/pdf/`, run at least one lightweight regression pass:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-pdf-regression.ps1
```

This check covers:

- Python / Conda environment resolution
- `translate_pdf.py --help` CLI smoke test
- `tests/pdf_regression_check.py` logic and import checks

## Manual Validation

If the change touches extraction, preservation, or rendering logic, also run a sample PDF manually:

```powershell
python src/pdf/translate_pdf.py extract input/1706.03762v7.pdf output/pdf_blocks_smoke.json --pages 1
```

At minimum, verify:

- `pdf_blocks.json` is generated
- `doclingSummary` exists
- `blocks[*].blockType / layoutIntent / preserveOriginal` look structurally reasonable
- the filled PDF opens successfully

## Further Refactoring Notes

- If refactoring continues, prioritize shrinking `domain/core.py`
- Prefer splitting highly cohesive, frequently changing clusters rather than splitting by import count
- Avoid reintroducing shim files that only forward single calls
