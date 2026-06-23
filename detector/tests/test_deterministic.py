"""Unit tests for the deterministic (regex + checksum) layer."""

from itertools import pairwise

from detector.deterministic import detect_deterministic
from detector.entities import (
    CREDIT_CARD,
    EMAIL_ADDRESS,
    IBAN_CODE,
    IP_ADDRESS,
    PHONE_NUMBER,
    VAT_CODE,
)


def types_texts(text, phone_regions=None):
    return [
        (s.entity_type, text[s.start : s.end]) for s in detect_deterministic(text, phone_regions)
    ]


# --- IBAN ---
def test_iban_plain():
    assert (IBAN_CODE, "IT60X0542811101000000123456") in types_texts(
        "IBAN: IT60X0542811101000000123456"
    )


def test_iban_spaced_keeps_spacing_in_span():
    text = "Bonifico IBAN IT60 X054 2811 1010 0000 0123 456 entro lunedì"
    assert (IBAN_CODE, "IT60 X054 2811 1010 0000 0123 456") in types_texts(text)


def test_iban_german():
    assert (IBAN_CODE, "DE89 3704 0044 0532 0130 00") in types_texts(
        "auf IBAN DE89 3704 0044 0532 0130 00"
    )


def test_iban_invalid_checksum_rejected():
    assert types_texts("IBAN errato: IT60X0542811101000000123457") == []


def test_iban_lowercase():
    assert (IBAN_CODE, "de89 3704 0044 0532 0130 00") in types_texts(
        "bitte auf iban de89 3704 0044 0532 0130 00"
    )


def test_iban_lowercase_does_not_bleed_into_following_word():
    spans = detect_deterministic("iban de89 3704 0044 0532 0130 00 grazie")
    iban = next(s for s in spans if s.entity_type == IBAN_CODE)
    text = "iban de89 3704 0044 0532 0130 00 grazie"
    assert "grazie" not in text[iban.start : iban.end]


def test_iban_does_not_bleed_into_following_word():
    # The lowercase word after the IBAN must not be swallowed.
    spans = detect_deterministic("IBAN IT60 X054 2811 1010 0000 0123 456 entro")
    iban = next(s for s in spans if s.entity_type == IBAN_CODE)
    assert "entro" not in "IBAN IT60 X054 2811 1010 0000 0123 456 entro"[iban.start : iban.end]


# --- VAT (EU, stdnum-validated) ---
def test_vat_valid_multiple_countries():
    for v in [
        "DE136695976",
        "IT00743110157",
        "FR40303265045",
        "ESA13585625",
        "ATU13585627",
        "BE0428759497",
        "PL5260001246",
    ]:
        assert (VAT_CODE, v) in types_texts(f"VAT {v} on the invoice")


def test_vat_spaced_after_prefix():
    assert (VAT_CODE, "DE 136695976") in types_texts("USt-IdNr DE 136695976")


def test_vat_invalid_checksum_rejected():
    assert all(t != VAT_CODE for t, _ in types_texts("VAT DE136695977 is wrong"))


def test_vat_does_not_claim_iban():
    # An IBAN must stay IBAN_CODE and never be mistagged as VAT.
    text = "auf IBAN DE89 3704 0044 0532 0130 00"
    types = types_texts(text)
    assert (IBAN_CODE, "DE89 3704 0044 0532 0130 00") in types
    assert all(t != VAT_CODE for t, _ in types)


def test_vat_label_prefix_not_absorbed():
    # A 2-letter label before the VAT (e.g. "ID") must not be taken as the country prefix.
    for text in ["Tax ID DE136695976 here", "Steuer-ID DE136695976 anbei"]:
        assert (VAT_CODE, "DE136695976") in types_texts(text)


def test_vat_lowercase():
    assert (VAT_CODE, "de136695976") in types_texts("the vat is de136695976.")
    assert (VAT_CODE, "it00743110157") in types_texts("partita iva it00743110157.")


def test_vat_word_prefix_does_not_swallow_following_vat():
    # A lowercase word that is also a country code ("es", "it") must not hide the real VAT.
    for text in ["es DE136695976", "it DE136695976"]:
        assert (VAT_CODE, "DE136695976") in types_texts(text)


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


def test_ipv4_trailing_period():
    # A sentence-ending period must not hide the address.
    assert (IP_ADDRESS, "8.8.8.8") in types_texts("Public DNS is 8.8.8.8.")


def test_ipv4_five_octets_rejected():
    # A fifth octet means it is a longer dotted-numeric token, not an IP.
    assert all(t != IP_ADDRESS for t, _ in types_texts("version 8.8.8.8.8 here"))


def test_ipv6_full():
    addr = "2001:0db8:85a3:0000:0000:8a2e:0370:7334"
    assert (IP_ADDRESS, addr) in types_texts(f"server at {addr} listens")


def test_ipv6_compressed():
    assert (IP_ADDRESS, "2001:db8::1") in types_texts("ping 2001:db8::1 now")


def test_ipv6_trailing_period():
    # A sentence-ending period must not hide the address (mirrors IPv4).
    assert (IP_ADDRESS, "2001:db8::8a2e:370:7334") in types_texts(
        "The compressed IPv6 address is 2001:db8::8a2e:370:7334."
    )
    addr = "2001:0db8:85a3:0000:0000:8a2e:0370:7334"
    assert (IP_ADDRESS, addr) in types_texts(f"The IPv6 source address was {addr}.")


def test_ipv6_invalid_rejected():
    assert all(t != IP_ADDRESS for t, _ in types_texts("time was 12:34:56 today"))


def test_ipv6_mapped_ipv4_keeps_full_span():
    # IPv4-mapped IPv6 must be reported in full, not truncated to its IPv4 tail
    # (which would leave the "::ffff:" prefix unmasked).
    addr = "::ffff:192.168.0.1"
    assert (IP_ADDRESS, addr) in types_texts(f"addr {addr} here")


# --- Credit card ---
def test_credit_card_valid_luhn():
    assert (CREDIT_CARD, "4111 1111 1111 1111") in types_texts("Card: 4111 1111 1111 1111")


def test_credit_card_invalid_luhn_rejected():
    assert all(t != CREDIT_CARD for t, _ in types_texts("Card: 4111 1111 1111 1112"))


# --- Phone (VALID leniency: no FP on long ID digit runs) ---
def test_phone_german_national():
    assert (PHONE_NUMBER, "0171-1234567") in types_texts("Telefon 0171-1234567", ["DE"])


def test_phone_international():
    assert (PHONE_NUMBER, "+49 171 1234567") in types_texts("Tel: +49 171 1234567")


def test_phone_regions_control_national_formats():
    assert (PHONE_NUMBER, "98765 43210") in types_texts(
        "Please call the customer on 98765 43210.", ["IN"]
    )
    assert (PHONE_NUMBER, "06 6982") in types_texts(
        "El contacto italiano atiende en 06 6982.", ["IT"]
    )


def test_phone_default_regions_keep_longest_overlap():
    types = types_texts("Please call the customer on 98765 43210.")
    assert (PHONE_NUMBER, "98765 43210") in types
    assert (PHONE_NUMBER, "43210") not in types


def test_phone_no_false_positive_on_invoice_number():
    assert all(t != PHONE_NUMBER for t, _ in types_texts("Rechnung 2893081508152 vom"))


def test_phone_english_uk_national():
    assert (PHONE_NUMBER, "0121 234 5678") in types_texts(
        "The Birmingham callback number is 0121 234 5678.", ["GB"]
    )


def test_phone_german_extra_regions():
    assert (PHONE_NUMBER, "01 234567890") in types_texts(
        "Die Wiener Kontaktnummer ist 01 234567890.", ["AT"]
    )
    assert (PHONE_NUMBER, "0848 800 800") in types_texts(
        "Die Schweizer Kontaktnummer ist 0848 800 800.", ["CH"]
    )


def test_phone_french_extra_regions():
    assert (PHONE_NUMBER, "012 34 56 78") in types_texts(
        "Le numéro belge du contact est 012 34 56 78.", ["BE"]
    )
    assert (PHONE_NUMBER, "0848 800 800") in types_texts(
        "Le numéro suisse du contact est 0848 800 800.", ["CH"]
    )
    assert (PHONE_NUMBER, "27 12 34 56") in types_texts(
        "Le numéro luxembourgeois du contact est 27 12 34 56.", ["LU"]
    )


def test_phone_dutch_belgium_region():
    assert (PHONE_NUMBER, "012 34 56 78") in types_texts(
        "Het Belgische telefoonnummer is 012 34 56 78.", ["BE"]
    )


def test_phone_portuguese_brazil_region():
    assert (PHONE_NUMBER, "(11) 2345-6789") in types_texts(
        "O número brasileiro do contato é (11) 2345-6789.", ["BR"]
    )


def test_phone_polish_and_romanian_primary_regions():
    assert (PHONE_NUMBER, "12 345 67 89") in types_texts(
        "Numer krajowy kontaktu to 12 345 67 89.", ["PL"]
    )
    assert (PHONE_NUMBER, "021 123 4567") in types_texts(
        "Numărul național al contactului este 021 123 4567.", ["RO"]
    )


def test_phone_romanian_moldova_region():
    assert (PHONE_NUMBER, "022 212 345") in types_texts(
        "Numărul de contact din Moldova este 022 212 345.", ["MD"]
    )


# --- overlap / priority ---
def test_no_overlapping_spans():
    text = "IBAN IT60 X054 2811 1010 0000 0123 456, mail luca@example.it"
    spans = detect_deterministic(text)
    spans.sort(key=lambda s: s.start)
    for a, b in pairwise(spans):
        assert a.end <= b.start


def test_empty_text():
    assert detect_deterministic("") == []
