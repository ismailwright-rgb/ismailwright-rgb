"""Full ingest -> chunk -> embed(stub) -> store -> retrieve loop, fully
offline. Proves core/retrieve.py's metadata plumbing is correct end to
end. Does NOT prove real semantic retrieval quality — StubEmbedder is
hash-based, not semantic; that property can only be verified on a machine
running the real Ollama embedding model (see README.internal.md)."""
from core.chunk import chunk_pages
from core.ingest import extract_document
from core.retrieve import retrieve_passages
from core.store import CaseStore
from tests.stub_embedder import StubEmbedder


def test_full_pipeline_ingest_to_retrieve(tmp_data_root, sample_case_fixtures):
    case_id = "maria_delgado"
    embedder = StubEmbedder()
    store = CaseStore(tmp_data_root, case_id)

    for doc_id, doc_path in [
        ("medical_record_dr_chen", sample_case_fixtures["medical_record"]),
        ("er_intake_scanned", sample_case_fixtures["er_intake_scanned"]),
    ]:
        pages = extract_document(doc_path)
        chunks = chunk_pages(case_id, doc_id, doc_path.name, pages)
        vectors = embedder.embed_texts([c.text for c in chunks])
        store.add_chunks(chunks, vectors)

    assert store.count() == 5  # 4 pages from the medical record + 1 from the scanned intake

    # Query using the exact page-3 causation text as the "question" —
    # verifies the whole chain returns that exact chunk with correct metadata.
    page3_pages = extract_document(sample_case_fixtures["medical_record"])
    page3_text = next(p for p in page3_pages if p.page == 3).text
    results = retrieve_passages(case_id, page3_text, embedder, tmp_data_root, top_k=3)

    assert results, "expected at least one retrieved passage"
    top = results[0]
    assert top.page == 3
    assert top.doc_name == "medical_record_dr_chen.pdf"
    assert "causation" in top.text.lower()
