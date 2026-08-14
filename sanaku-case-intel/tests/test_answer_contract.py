"""Cheap regression guard on prompts/answer_contract.txt itself - not
testing model behavior (that needs a live model), just that the contract
text a future edit might accidentally weaken or delete is still there."""
from core.generate import CONTRACT_PATH


def test_contract_still_has_five_numbered_rules():
    text = CONTRACT_PATH.read_text()
    for n in range(1, 6):
        assert f"{n}." in text, f"rule {n} missing from answer_contract.txt"


def test_contract_rule_5_scopes_conversation_history_as_context_only():
    text = CONTRACT_PATH.read_text()
    assert "CONVERSATION HISTORY" in text
    assert "never" in text.lower()
