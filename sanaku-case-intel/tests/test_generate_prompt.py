"""Pure string-formatting tests for the citation-contract prompt assembly —
no I/O, no Ollama, no network. Checks that every passage handed to the
model carries a citation-ready [doc_name, p.<page>] header and that
human_entered/approximate/undated flags actually reach the prompt text,
since prompts/answer_contract.txt's rule #3 depends on the model being able
to see those flags to honor them."""
from core.generate import build_user_prompt
from core.retrieve import RetrievedChunk


def test_build_user_prompt_includes_citation_ready_headers():
    passage = RetrievedChunk(
        doc_id="doc", doc_name="medical_record_dr_chen.pdf", page=3, chunk_index=0,
        source_type="digital", event_date=None, date_confidence="undated",
        human_entered=False, text="causation opinion text", distance=0.05,
    )
    prompt = build_user_prompt("What did the physician say about causation?", [passage])
    assert "medical_record_dr_chen.pdf, p.3" in prompt
    assert "causation opinion text" in prompt


def test_build_user_prompt_spells_out_the_exact_citation_string():
    """Confirmed live (2026-08): without this, a model cites the passage's
    list position ("(passage [2], p.3)") instead of building [doc_name,
    p.X] from the metadata beside it - sometimes dropping the page number
    entirely. The prompt must say, in so many words, what string to use."""
    passage = RetrievedChunk(
        doc_id="doc", doc_name="medical_record_dr_chen.pdf", page=3, chunk_index=0,
        source_type="digital", event_date=None, date_confidence="undated",
        human_entered=False, text="causation opinion text", distance=0.05,
    )
    prompt = build_user_prompt("question", [passage])
    assert "cite this as [medical_record_dr_chen.pdf, p.3]" in prompt


def test_build_user_prompt_flags_human_entered_and_approximate():
    passage = RetrievedChunk(
        doc_id="note", doc_name="paralegal_notes", page=1, chunk_index=0,
        source_type="manual", event_date="2024-02-15", date_confidence="approximate",
        human_entered=True, text="client mentioned back pain started around this time", distance=0.2,
    )
    prompt = build_user_prompt("when did symptoms start?", [passage])
    assert "human_entered" in prompt
    assert "date_confidence=approximate" in prompt


def test_build_user_prompt_does_not_flag_exact_dated_digital_passages():
    passage = RetrievedChunk(
        doc_id="doc", doc_name="medical_record_dr_chen.pdf", page=3, chunk_index=0,
        source_type="digital", event_date="2024-03-18", date_confidence="exact",
        human_entered=False, text="causation opinion text", distance=0.05,
    )
    prompt = build_user_prompt("question", [passage])
    # exact-dated, non-human-entered passages shouldn't carry a flag block at all
    assert "human_entered" not in prompt
    assert "date_confidence=exact" not in prompt  # exact is the unflagged default, not called out


def test_build_user_prompt_handles_no_passages():
    prompt = build_user_prompt("any question", [])
    assert "no passages retrieved" in prompt.lower()


def test_build_user_prompt_numbers_passages_sequentially():
    passages = [
        RetrievedChunk(doc_id="a", doc_name="a.pdf", page=1, chunk_index=0, source_type="digital",
                        event_date=None, date_confidence="undated", human_entered=False, text="text a", distance=0.1),
        RetrievedChunk(doc_id="b", doc_name="b.pdf", page=2, chunk_index=0, source_type="digital",
                        event_date=None, date_confidence="undated", human_entered=False, text="text b", distance=0.2),
    ]
    prompt = build_user_prompt("question", passages)
    assert "Passage 1 — cite this as [a.pdf, p.1]" in prompt
    assert "Passage 2 — cite this as [b.pdf, p.2]" in prompt
