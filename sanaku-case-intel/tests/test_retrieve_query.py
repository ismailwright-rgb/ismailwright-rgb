"""Pure unit tests for build_retrieval_query - no I/O, no embeddings, no
ChromaDB. Confirms the query-folding heuristic itself, not retrieval
quality (that needs live embeddings, see README.internal.md)."""
from core.retrieve import ConversationTurn, build_retrieval_query


def test_build_retrieval_query_with_no_history_returns_question_unchanged():
    assert build_retrieval_query("What did the physician say about causation?", None) == \
        "What did the physician say about causation?"
    assert build_retrieval_query("What did the physician say about causation?", []) == \
        "What did the physician say about causation?"


def test_build_retrieval_query_folds_prior_question_text_in():
    history = [ConversationTurn(
        question="What did the treating physician say about causation?",
        answer="Dr. Chen concluded causation. [medical_record_dr_chen.pdf, p.3]",
    )]
    query = build_retrieval_query("What about her prior injuries?", history)
    assert "What did the treating physician say about causation?" in query
    assert "What about her prior injuries?" in query
    # Answers are deliberately excluded - already citation-laden, would
    # skew the embedding toward what was already retrieved last turn.
    assert "Dr. Chen" not in query


def test_build_retrieval_query_caps_at_max_prior_turns():
    history = [
        ConversationTurn(question="first question", answer="a1"),
        ConversationTurn(question="second question", answer="a2"),
        ConversationTurn(question="third question", answer="a3"),
    ]
    query = build_retrieval_query("fourth question", history, max_prior_turns=2)
    assert "first question" not in query
    assert "second question" in query
    assert "third question" in query
    assert "fourth question" in query
