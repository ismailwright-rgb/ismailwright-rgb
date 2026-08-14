from core.chunk import chunk_pages
from core.ingest import PageText


def test_chunk_preserves_page_number_and_never_crosses_pages():
    pages = [
        PageText(page=1, text=" ".join(["word"] * 2000), source_type="digital"),
        PageText(page=2, text="short page", source_type="digital"),
    ]
    chunks = chunk_pages("case1", "doc1", "doc1.pdf", pages, target_tokens=100, overlap_tokens=10)
    assert all(c.page in (1, 2) for c in chunks)
    page1_chunks = [c for c in chunks if c.page == 1]
    page2_chunks = [c for c in chunks if c.page == 2]
    assert len(page1_chunks) > 1  # long page 1 must sub-chunk
    assert len(page2_chunks) == 1  # short page 2 fits in one chunk
    # chunk_index restarts per page and increments within a page
    assert [c.chunk_index for c in page1_chunks] == list(range(len(page1_chunks)))
    assert page2_chunks[0].chunk_index == 0


def test_chunk_overlap_present_between_consecutive_chunks_on_long_page():
    pages = [PageText(page=1, text=" ".join(f"w{i}" for i in range(500)), source_type="digital")]
    chunks = chunk_pages("case1", "doc1", "doc1.pdf", pages, target_tokens=100, overlap_tokens=20)
    assert len(chunks) >= 2
    first_words = chunks[0].text.split()
    second_words = chunks[1].text.split()
    overlap = set(first_words[-10:]) & set(second_words[:10])
    assert overlap, "expected some word overlap between consecutive chunks"


def test_chunk_schema_fields_default_correctly():
    pages = [PageText(page=1, text="hello world", source_type="digital")]
    chunks = chunk_pages("case1", "doc1", "doc1.pdf", pages)
    c = chunks[0]
    assert c.case_id == "case1"
    assert c.doc_id == "doc1"
    assert c.doc_name == "doc1.pdf"
    assert c.source_type == "digital"
    assert c.event_date is None
    assert c.date_confidence == "undated"
    assert c.human_entered is False
    assert isinstance(c.text, str) and c.text


def test_chunk_source_type_scanned_propagates():
    pages = [PageText(page=1, text="ocr text here", source_type="scanned")]
    chunks = chunk_pages("case1", "doc1", "doc1.pdf", pages)
    assert chunks[0].source_type == "scanned"


def test_empty_page_produces_no_chunks():
    pages = [PageText(page=1, text="", source_type="digital")]
    chunks = chunk_pages("case1", "doc1", "doc1.pdf", pages)
    assert chunks == []
