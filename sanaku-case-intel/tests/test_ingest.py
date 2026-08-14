from core.ingest import extract_document


def test_digital_pdf_extracts_correct_pages_and_tags(sample_case_fixtures):
    pages = extract_document(sample_case_fixtures["medical_record"])
    assert len(pages) == 4
    assert [p.page for p in pages] == [1, 2, 3, 4]
    assert all(p.source_type == "digital" for p in pages)
    assert all(len(p.text) > 0 for p in pages)


def test_digital_pdf_page3_has_causation_content(sample_case_fixtures):
    pages = extract_document(sample_case_fixtures["medical_record"])
    page3 = next(p for p in pages if p.page == 3)
    assert "causation" in page3.text.lower()
    assert "l4-l5" in page3.text.lower() or "l4–l5" in page3.text.lower()


def test_scanned_pdf_routes_through_ocr_and_is_tagged_scanned(sample_case_fixtures):
    pages = extract_document(sample_case_fixtures["er_intake_scanned"])
    assert len(pages) == 1
    assert pages[0].source_type == "scanned"
    # Real OCR output, not a mock — confirms tesseract actually ran and read
    # text that only exists as pixels in the source PDF.
    assert "maria delgado" in pages[0].text.lower()
    assert "intake" in pages[0].text.lower()


def test_unsupported_extension_raises():
    import pytest
    from pathlib import Path

    with pytest.raises(ValueError):
        extract_document(Path("nonexistent.docx"))
