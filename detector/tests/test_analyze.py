"""Integration tests for the /analyze HTTP contract.

GLiNER is stubbed so these are fast and deterministic; the deterministic layer
and the merge/contract behaviour are exercised for real.
"""

import pytest
from fastapi.testclient import TestClient

import detector.app as appmod
from detector.entities import LOCATION, PERSON, PHONE_NUMBER, Span


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(appmod, "load_model", lambda: None)

    def fake_gliner(text, score_threshold=0.0):
        spans = []
        for needle, etype in (("Mario Rossi", PERSON), ("München", LOCATION)):
            i = text.find(needle)
            # person/location are tunable: honor the request threshold like the
            # real per-label floor would.
            if i >= 0 and score_threshold <= 0.95:
                spans.append(Span(etype, i, i + len(needle), 0.95))
        return spans

    monkeypatch.setattr(appmod, "detect_gliner", fake_gliner)
    with TestClient(appmod.app) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_response_shape_and_offsets(client):
    text = "IBAN IT60X0542811101000000123456"
    r = client.post("/analyze", json={"text": text, "score_threshold": 0.7})
    assert r.status_code == 200
    body = r.json()
    assert body and all({"entity_type", "start", "end", "score"} == set(e) for e in body)
    for e in body:
        # offsets index into the submitted text
        assert text[e["start"] : e["end"]]
    assert any(e["entity_type"] == "IBAN_CODE" for e in body)


def test_routing_iban_in_german_text(client):
    text = "Der Mandant Mario Rossi (IT60X0542811101000000123456) zahlt."
    r = client.post("/analyze", json={"text": text, "score_threshold": 0.7})
    types = {e["entity_type"] for e in r.json()}
    assert "IBAN_CODE" in types
    assert "PERSON" in types  # from the (stubbed) multilingual NER


def test_entity_filter(client):
    text = "Mario Rossi, IBAN IT60X0542811101000000123456"
    r = client.post(
        "/analyze",
        json={
            "text": text,
            "entities": ["IBAN_CODE"],
            "score_threshold": 0.7,
        },
    )
    types = {e["entity_type"] for e in r.json()}
    assert types == {"IBAN_CODE"}


def test_phone_regions_control_national_formats(client):
    text = "English ticket text with Indian callback 98765 43210."
    r = client.post(
        "/analyze",
        json={
            "text": text,
            "phone_regions": ["IN"],
            "entities": ["PHONE_NUMBER"],
            "score_threshold": 0.7,
        },
    )
    types = {e["entity_type"] for e in r.json()}
    assert PHONE_NUMBER in types


def test_score_threshold_drops_fuzzy_keeps_deterministic(client):
    text = "Mario Rossi, IBAN IT60X0542811101000000123456"
    r = client.post("/analyze", json={"text": text, "score_threshold": 0.99})
    types = {e["entity_type"] for e in r.json()}
    assert "IBAN_CODE" in types  # deterministic, score 1.0
    assert "PERSON" not in types  # fuzzy 0.95 < 0.99


def test_minimal_request_never_errors(client):
    r = client.post("/analyze", json={"text": "test", "entities": ["PERSON"]})
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_empty_text(client):
    r = client.post("/analyze", json={"text": ""})
    assert r.status_code == 200
    assert r.json() == []


def test_utf16_offsets_with_astral_char(client):
    # An emoji (astral, 2 UTF-16 code units) before the email must shift the
    # returned offsets so PasteGuard's JS text.slice lands on the email.
    text = "Hi 😀 mail@x.com"
    r = client.post("/analyze", json={"text": text, "score_threshold": 0.7})
    email = next(e for e in r.json() if e["entity_type"] == "EMAIL_ADDRESS")
    # JS code units: "Hi " (3) + emoji (2) + " " (1) = 6
    assert email["start"] == 6
    # Simulate the JS consumer: slice as UTF-16 code units.
    u16 = text.encode("utf-16-le")
    sliced = u16[email["start"] * 2 : email["end"] * 2].decode("utf-16-le")
    assert sliced == "mail@x.com"
