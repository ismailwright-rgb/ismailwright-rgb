from pathlib import Path

from core.chunk import chunk_pages
from core.ingest import extract_document
from core.retrieve import retrieve_passages
from core.store import CaseStore
from tests.stub_embedder import StubEmbedder


def _ingest_case(data_root: Path, case_id: str, doc_path: Path, doc_id: str):
    embedder = StubEmbedder()
    pages = extract_document(doc_path)
    chunks = chunk_pages(case_id, doc_id, doc_path.name, pages)
    vectors = embedder.embed_texts([c.text for c in chunks])
    store = CaseStore(data_root, case_id)
    store.add_chunks(chunks, vectors)
    return store, chunks, embedder


def test_exact_text_query_returns_matching_chunk_first(tmp_data_root, sample_case_fixtures):
    store, chunks, embedder = _ingest_case(
        tmp_data_root, "case_a", sample_case_fixtures["medical_record"], "medical_record_dr_chen"
    )
    page3_chunk = next(c for c in chunks if c.page == 3)
    q_vec = embedder.embed_query(page3_chunk.text)
    result = store.query(q_vec, top_k=4)
    assert result["metadatas"][0][0]["page"] == 3
    assert result["distances"][0][0] == 0.0


def test_metadata_round_trips_through_retrieve_passages(tmp_data_root, sample_case_fixtures):
    store, chunks, embedder = _ingest_case(
        tmp_data_root, "case_a", sample_case_fixtures["medical_record"], "medical_record_dr_chen"
    )
    page3_chunk = next(c for c in chunks if c.page == 3)
    results = retrieve_passages("case_a", page3_chunk.text, embedder, tmp_data_root, top_k=4)
    top = results[0]
    assert top.page == 3
    assert top.doc_name == "medical_record_dr_chen.pdf"
    assert top.source_type == "digital"
    assert top.human_entered is False
    assert top.date_confidence == "undated"
    assert top.event_date is None  # "" stored in Chroma converts back to None


def test_case_isolation(tmp_data_root, sample_case_fixtures):
    _ingest_case(tmp_data_root, "case_a", sample_case_fixtures["medical_record"], "doc")
    store_b = CaseStore(tmp_data_root, "case_b")
    assert store_b.count() == 0


def test_persistence_across_reopen(tmp_data_root, sample_case_fixtures):
    store, chunks, _ = _ingest_case(
        tmp_data_root, "case_a", sample_case_fixtures["medical_record"], "doc"
    )
    original_count = store.count()
    reopened = CaseStore(tmp_data_root, "case_a")
    assert reopened.count() == original_count == len(chunks)


def test_retrieve_on_empty_case_returns_empty_list(tmp_data_root):
    embedder = StubEmbedder()
    results = retrieve_passages("nonexistent_case", "any question", embedder, tmp_data_root, top_k=4)
    assert results == []


def test_upsert_is_idempotent_on_reingest(tmp_data_root, sample_case_fixtures):
    store, chunks, embedder = _ingest_case(
        tmp_data_root, "case_a", sample_case_fixtures["medical_record"], "doc"
    )
    count_after_first = store.count()
    # re-ingest the exact same document -> same deterministic ids -> upsert, not duplicate
    vectors = embedder.embed_texts([c.text for c in chunks])
    store.add_chunks(chunks, vectors)
    assert store.count() == count_after_first
