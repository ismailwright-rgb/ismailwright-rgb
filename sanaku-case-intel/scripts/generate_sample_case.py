#!/usr/bin/env python3
"""Dev-only generator for the fictional "Maria Delgado" sample case used by
the Phase 3 demo and by tests/. NOT part of the shipped app — never run by
scripts/setup.sh, and reportlab is only in requirements-dev.txt for exactly
this reason.

Produces two fixture PDFs under sample_cases/maria_delgado/documents/:

  medical_record_dr_chen.pdf  — born-digital (real text layer), 4 pages.
                                 Page 3 carries a physician's causation
                                 opinion — this is the exact passage the
                                 Phase 3 acceptance question ("What did the
                                 treating physician say about causation?")
                                 needs to find and cite.

  er_intake_scanned.pdf       — genuinely text-layer-free: the page content
                                 is a PIL-rendered image embedded into the
                                 PDF, not real text. This exercises the OCR
                                 fallback path in core/ingest.py for real,
                                 not via a simulated/mocked "scanned" flag.

Every document is explicitly labeled FICTIONAL DEMO DATA. No real client
or patient information is ever used here.
"""
from __future__ import annotations

from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

OUT_DIR = Path(__file__).resolve().parent.parent / "sample_cases" / "maria_delgado" / "documents"

DISCLAIMER = "FICTIONAL DEMO DATA — not a real patient, firm, or provider."


def _draw_wrapped(c: canvas.Canvas, text: str, x: float, y: float, max_chars: int = 95, leading: float = 14) -> float:
    """Minimal word-wrap for reportlab's canvas — returns the y position after the block."""
    import textwrap

    for line in textwrap.wrap(text, max_chars):
        c.drawString(x, y, line)
        y -= leading
    return y


def build_medical_record(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=LETTER)
    width, height = LETTER
    margin = 1 * inch

    # --- Page 1: header / patient info ---
    c.setFont("Helvetica-Bold", 14)
    c.drawString(margin, height - margin, "Example Medical Group — Orthopedic Consultation")
    c.setFont("Helvetica-Oblique", 9)
    c.drawString(margin, height - margin - 16, DISCLAIMER)
    c.setFont("Helvetica", 11)
    y = height - margin - 50
    for line in [
        "Patient: Maria Delgado (fictional)",
        "DOB: 04/11/1985 (fictional)",
        "Date of visit: 2024-03-18 (fictional)",
        "Treating physician: Dr. Sarah Chen, MD — Orthopedic Surgery",
        "Referring event: motor vehicle collision, 2024-02-02 (fictional)",
    ]:
        c.drawString(margin, y, line)
        y -= 18
    c.showPage()

    # --- Page 2: history of present illness ---
    c.setFont("Helvetica-Bold", 13)
    c.drawString(margin, height - margin, "History of Present Illness")
    c.setFont("Helvetica", 11)
    y = height - margin - 30
    y = _draw_wrapped(
        c,
        "Ms. Delgado presents four weeks status-post a motor vehicle collision on "
        "2024-02-02 (fictional). She reports she was a restrained driver, stopped "
        "at a red light, when her vehicle was struck from behind. She reports "
        "immediate onset of lower back pain radiating into the left leg, with "
        "associated numbness and tingling. She was evaluated at an emergency "
        "department the same day and was subsequently referred to this office for "
        "orthopedic evaluation.",
        margin,
        y,
    )
    y -= 10
    y = _draw_wrapped(
        c,
        "Prior to the collision, the patient reports no history of lower back pain, "
        "no prior lumbar injury, and no prior spine treatment of any kind. She was "
        "fully active without limitation.",
        margin,
        y,
    )
    c.showPage()

    # --- Page 3: the causation opinion — this is the passage the demo question targets ---
    c.setFont("Helvetica-Bold", 13)
    c.drawString(margin, height - margin, "Assessment and Causation Opinion")
    c.setFont("Helvetica", 11)
    y = height - margin - 30
    y = _draw_wrapped(
        c,
        "MRI of the lumbar spine obtained on 2024-03-04 (fictional) demonstrates an "
        "L4-L5 disc herniation with associated left-sided nerve root impingement, "
        "correlating with the patient's reported radicular symptoms.",
        margin,
        y,
    )
    y -= 10
    c.setFont("Helvetica-Bold", 11)
    c.drawString(margin, y, "Causation:")
    y -= 18
    c.setFont("Helvetica", 11)
    y = _draw_wrapped(
        c,
        "It is my opinion, to a reasonable degree of medical certainty, that Ms. "
        "Delgado's L4-L5 disc herniation and associated radicular symptoms are "
        "causally related to the motor vehicle collision of 2024-02-02 (fictional). "
        "This opinion is based on the temporal relationship between the collision "
        "and symptom onset, the absence of any prior lumbar spine complaints in "
        "this patient's history, and imaging findings consistent with an acute "
        "traumatic disc injury rather than a chronic degenerative process.",
        margin,
        y,
    )
    c.showPage()

    # --- Page 4: treatment plan / signature ---
    c.setFont("Helvetica-Bold", 13)
    c.drawString(margin, height - margin, "Treatment Plan")
    c.setFont("Helvetica", 11)
    y = height - margin - 30
    y = _draw_wrapped(
        c,
        "Recommend a course of physical therapy, twice weekly for six weeks, with "
        "re-evaluation thereafter. Surgical intervention is not indicated at this "
        "time but may be reconsidered if conservative treatment fails to improve "
        "symptoms.",
        margin,
        y,
    )
    y -= 40
    c.drawString(margin, y, "Sarah Chen, MD (fictional signature)")
    c.showPage()

    c.save()


def build_scanned_er_intake(path: Path) -> None:
    """Builds a PDF page whose ONLY content is a rasterized image — a
    genuinely text-layer-free page, exercising core/ingest.py's OCR
    fallback for real rather than via a simulated flag."""
    img = Image.new("RGB", (1700, 2200), "white")
    draw = ImageDraw.Draw(img)
    try:
        font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 34)
        font_body = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 26)
    except OSError:
        font_title = ImageFont.load_default()
        font_body = ImageFont.load_default()

    y = 100
    draw.text((100, y), "Example Emergency Department — Intake Form", fill="black", font=font_title)
    y += 60
    draw.text((100, y), DISCLAIMER, fill="black", font=font_body)
    y += 80
    lines = [
        "Patient: Maria Delgado (fictional)",
        "Date of visit: 2024-02-02 (fictional)",
        "Chief complaint: lower back pain following motor vehicle collision",
        "Mechanism: rear-end collision, restrained driver, immediate pain onset",
        "Vitals: BP 128/82, HR 88, stable",
        "Disposition: referred to orthopedics for further evaluation",
    ]
    for line in lines:
        draw.text((100, y), line, fill="black", font=font_body)
        y += 50

    doc = fitz.open()
    page = doc.new_page(width=img.width, height=img.height)
    img_path = path.with_suffix(".tmp.png")
    img.save(img_path)
    page.insert_image(page.rect, filename=str(img_path))
    doc.save(str(path))
    doc.close()
    img_path.unlink(missing_ok=True)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    build_medical_record(OUT_DIR / "medical_record_dr_chen.pdf")
    build_scanned_er_intake(OUT_DIR / "er_intake_scanned.pdf")
    print(f"Wrote fixtures to {OUT_DIR}")


if __name__ == "__main__":
    main()
