"""Document ingestion: extract text per page, with page numbers preserved,
and fall back to OCR for pages that have no text layer (scanned pages).

Uses PyMuPDF's own pixmap rasterizer for the OCR fallback rather than
pdf2image — that drops the poppler system dependency entirely. The only
system dependency this module needs is the tesseract-ocr binary itself
(apt on Linux dev machines, `brew install tesseract` on the target Mac
Mini).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import fitz  # PyMuPDF
import pytesseract
from PIL import Image

# Pages with fewer real characters than this are treated as having no text
# layer at all (a scanned image with no OCR'd/embedded text) and routed
# through the OCR fallback instead of trusted as-is.
MIN_TEXT_CHARS = 20

SourceType = Literal["digital", "scanned"]


@dataclass
class PageText:
    page: int  # 1-indexed, matches how a human reads the document
    text: str
    source_type: SourceType


def extract_pdf_pages(pdf_path: Path, ocr_lang: str = "eng") -> list[PageText]:
    """Extract per-page text from a PDF, OCR'ing any page with no real text layer.

    Every returned PageText carries the page number it actually came from —
    that page tag is the whole point of this system (every downstream
    citation traces back to it), so it must never be inferred or dropped.
    """
    doc = fitz.open(pdf_path)
    try:
        pages: list[PageText] = []
        for i, page in enumerate(doc, start=1):
            text = page.get_text("text").strip()
            if len(text) >= MIN_TEXT_CHARS:
                pages.append(PageText(page=i, text=text, source_type="digital"))
            else:
                ocr_text = _ocr_page(page, ocr_lang)
                pages.append(PageText(page=i, text=ocr_text, source_type="scanned"))
        return pages
    finally:
        doc.close()


def _ocr_page(page: "fitz.Page", lang: str) -> str:
    # 300 DPI is a standard OCR-quality tradeoff: high enough for tesseract
    # to read normal document text reliably, without ballooning memory on a
    # large scanned exhibit.
    pix = page.get_pixmap(dpi=300)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    return pytesseract.image_to_string(img, lang=lang).strip()


def extract_txt(txt_path: Path) -> list[PageText]:
    """Plain-text documents have no page concept — treated as one page."""
    text = txt_path.read_text(encoding="utf-8", errors="replace").strip()
    return [PageText(page=1, text=text, source_type="digital")]


def extract_document(doc_path: Path, ocr_lang: str = "eng") -> list[PageText]:
    """Dispatch by extension. Raises ValueError on an unsupported type
    rather than silently skipping a document a firm expects to be searchable."""
    suffix = doc_path.suffix.lower()
    if suffix == ".pdf":
        return extract_pdf_pages(doc_path, ocr_lang=ocr_lang)
    if suffix == ".txt":
        return extract_txt(doc_path)
    raise ValueError(f"Unsupported document type: {doc_path.suffix} ({doc_path})")
