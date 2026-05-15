from __future__ import annotations

import argparse
from typing import List, Set


def parse_pages(value: str) -> List[int]:
    pages: Set[int] = set()
    for raw_part in value.split(","):
        part = raw_part.strip()
        if not part:
            raise argparse.ArgumentTypeError("Empty segment in --pages selector.")

        if "-" in part:
            start_text, end_text = [segment.strip() for segment in part.split("-", 1)]
            if not start_text.isdigit() or not end_text.isdigit():
                raise argparse.ArgumentTypeError(
                    f'Invalid page range "{part}". Use positive integers like 2-4.'
                )
            start = int(start_text)
            end = int(end_text)
            if start <= 0 or end <= 0 or start > end:
                raise argparse.ArgumentTypeError(
                    f'Invalid page range "{part}". Start must be <= end and both must be positive.'
                )
            for page in range(start, end + 1):
                pages.add(page)
            continue

        if not part.isdigit() or int(part) <= 0:
            raise argparse.ArgumentTypeError(
                f'Invalid page "{part}". Use positive integers like 1,3,5.'
            )
        pages.add(int(part))

    return sorted(pages)
