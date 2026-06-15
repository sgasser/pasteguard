"""Unit tests for the deterministic (regex + checksum) layer."""

from detector.deterministic import detect_deterministic
from detector.entities import (
    CREDIT_CARD,
    DE_TAX_CODE,
    DE_VAT_CODE,
    EMAIL_ADDRESS,
    IBAN_CODE,
    IP_ADDRESS,
    IT_FISCAL_CODE,
    IT_VAT_CODE,
    PHONE_NUMBER,
)


def types_texts(text, language=""):
    return [(s.entity_type, text[s.start : s.end]) for s in detect_deterministic(text, language)]


# --- IBAN ---
def test_iban_plain():
    assert (IBAN_CODE, "IT60X0542811101000000123456") in types_texts(
        "IBAN: IT60X0542811101000000123456"
    )


def test_iban_spaced_keeps_spacing_in_span():
    text = "Bonifico IBAN IT60 X054 2811 1010 0000 0123 456 entro lunedì"
    assert (IBAN_CODE, "IT60 X054 2811 1010 0000 0123 456") in types_texts(text, "it")


def test_iban_german():
    assert (IBAN_CODE, "DE89 3704 0044 0532 0130 00") in types_texts(
        "auf IBAN DE89 3704 0044 0532 0130 00", "de"
    )


def test_iban_invalid_checksum_rejected():
    assert types_texts("IBAN errato: IT60X0542811101000000123457", "it") == []


def test_iban_does_not_bleed_into_following_word():
    # The lowercase word after the IBAN must not be swallowed.
    spans = detect_deterministic("IBAN IT60 X054 2811 1010 0000 0123 456 entro", "it")
    iban = next(s for s in spans if s.entity_type == IBAN_CODE)
    assert "entro" not in "IBAN IT60 X054 2811 1010 0000 0123 456 entro"[iban.start : iban.end]


# --- Codice Fiscale ---
def test_codice_fiscale_valid():
    assert (IT_FISCAL_CODE, "RSSMRA85T10H501O") in types_texts(
        "codice fiscale RSSMRA85T10H501O", "it"
    )


def test_codice_fiscale_invalid_rejected():
    assert types_texts("CF non valido: RSSMRA85T10H501A", "it") == []


# --- Partita IVA ---
def test_partita_iva_valid():
    assert (IT_VAT_CODE, "00743110157") in types_texts("partita IVA 00743110157", "it")


def test_partita_iva_invalid_no_false_positive():
    # Must not be flagged as IT_VAT_CODE *or* DE_TAX_CODE (regression: stdnum
    # de.stnr would accept this bare number without context).
    assert types_texts("Partita IVA errata: 00743110158", "it") == []


# --- German USt-IdNr ---
def test_de_vat_valid():
    assert (DE_VAT_CODE, "DE136695976") in types_texts("USt-IdNr DE136695976", "de")


def test_de_vat_invalid_rejected():
    assert all(t != DE_VAT_CODE for t, _ in types_texts("DE136695977", "de"))


# --- German Steuernummer (context-gated) ---
def test_steuernummer_with_context():
    assert (DE_TAX_CODE, "2893081508152") in types_texts(
        "Steuernummer des Mandanten: 2893081508152", "de"
    )


def test_steuernummer_abbrev_context():
    assert (DE_TAX_CODE, "2893081508152") in types_texts("St.-Nr. 2893081508152", "de")


def test_steuernummer_without_context_not_flagged():
    assert all(t != DE_TAX_CODE for t, _ in types_texts("Rechnung 2893081508152 vom Januar", "de"))


# --- Email / IP ---
def test_email():
    assert (EMAIL_ADDRESS, "john.doe@company.com") in types_texts("at john.doe@company.com")


def test_email_keeps_plus_and_underscore():
    assert (EMAIL_ADDRESS, "user+tag@example.com") in types_texts("to user+tag@example.com now")
    assert (EMAIL_ADDRESS, "first_last@sub.example.co.uk") in types_texts(
        "mail first_last@sub.example.co.uk here"
    )


def test_email_rejects_malformed():
    for bad in ("user@example..com", "user.@example.com", "user@.example.com"):
        assert all(t != EMAIL_ADDRESS for t, _ in types_texts(f"x {bad} y"))


def test_email_unicode_local_part_no_partial_leak():
    # Accented local parts must match in full, not leak a partial span.
    assert (EMAIL_ADDRESS, "müller@example.com") in types_texts("an müller@example.com")
    assert (EMAIL_ADDRESS, "andré.muller@example.fr") in types_texts("mail andré.muller@example.fr")


def test_ipv4():
    assert (IP_ADDRESS, "8.8.8.8") in types_texts("Server IP is 8.8.8.8")


def test_ipv4_invalid_octet_rejected():
    assert all(t != IP_ADDRESS for t, _ in types_texts("version 8.8.8.999 here"))


# --- Credit card ---
def test_credit_card_valid_luhn():
    assert (CREDIT_CARD, "4111 1111 1111 1111") in types_texts("Card: 4111 1111 1111 1111")


def test_credit_card_invalid_luhn_rejected():
    assert all(t != CREDIT_CARD for t, _ in types_texts("Card: 4111 1111 1111 1112"))


# --- Phone (VALID leniency: no FP on long ID digit runs) ---
def test_phone_german_national():
    assert (PHONE_NUMBER, "0171-1234567") in types_texts("Telefon 0171-1234567", "de")


def test_phone_international():
    assert (PHONE_NUMBER, "+49 171 1234567") in types_texts("Tel: +49 171 1234567", "de")


def test_phone_no_false_positive_on_invoice_number():
    assert all(t != PHONE_NUMBER for t, _ in types_texts("Rechnung 2893081508152 vom", "de"))


# --- overlap / priority ---
def test_no_overlapping_spans():
    text = "IBAN IT60 X054 2811 1010 0000 0123 456, CF RSSMRA85T10H501O"
    spans = detect_deterministic(text, "it")
    spans.sort(key=lambda s: s.start)
    for a, b in zip(spans, spans[1:]):
        assert a.end <= b.start


def test_empty_text():
    assert detect_deterministic("", "de") == []
