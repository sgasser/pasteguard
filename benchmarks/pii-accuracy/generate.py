"""Generate a large auto-labelled synthetic PII benchmark corpus with Faker.

Localized values are injected into per-language templates, so the ground-truth
spans are known without manual labelling. Deterministic (seeded) and
license-clean (Faker is MIT). Focuses on the statistically noisy fuzzy labels
(person/location/organization/address) plus email/IBAN across 7 languages;
checksum identifiers (VAT/CF/credit card/crypto/BIC) stay in the curated sets.

Requires: faker, pyyaml, python-stdnum.
Run:  detector/.venv/bin/python benchmarks/pii-accuracy/generate.py
Writes: benchmarks/pii-accuracy/test-data/generated.yaml  (category: eval)
"""

import os
import random

import yaml
from faker import Faker
from stdnum import iban as _iban

SEED = 42
OUT = os.path.join(os.path.dirname(__file__), "test-data", "generated.yaml")

LOCALES = {
    "de": "de_DE",
    "it": "it_IT",
    "fr": "fr_FR",
    "es": "es_ES",
    "nl": "nl_NL",
    "pt": "pt_PT",
    "en": "en_US",
}

# Legal-form suffixes the detector's org gate recognises (per language).
# FR (SARL) and PT (Lda) are not in the gate yet -> no org templates for them.
ORG_SUFFIX = {
    "de": ["GmbH", "AG"],
    "it": ["S.r.l.", "S.p.A."],
    "en": ["Inc", "Corp", "Ltd"],
    "nl": ["B.V."],
    "es": ["S.L.", "S.A."],
}
# A business word so org names are realistic multi-word ("Weber Logistik GmbH"),
# not bare "Lastname Suffix" which GLiNER reads as a person.
ORG_WORD = {
    "de": ["Logistik", "Beratung", "Handel", "Technik", "Bau"],
    "it": ["Logistica", "Consulenza", "Costruzioni", "Servizi"],
    "en": ["Logistics", "Consulting", "Trading", "Systems"],
    "nl": ["Logistiek", "Advies", "Handel", "Techniek"],
    "es": ["Logística", "Consultoría", "Servicios", "Construcciones"],
}

PL_TPL = {  # {p}=person {l}=location
    "de": ["Bitte {p} in {l} kontaktieren.", "{p} wohnt in {l}.", "Termin mit {p} aus {l}."],
    "it": ["Contattare {p} a {l}.", "{p} vive a {l}.", "Appuntamento con {p} di {l}."],
    "fr": ["Contactez {p} à {l}.", "{p} habite à {l}.", "Rendez-vous avec {p} de {l}."],
    "es": ["Contacte a {p} en {l}.", "{p} vive en {l}.", "Cita con {p} de {l}."],
    "nl": ["Neem contact op met {p} in {l}.", "{p} woont in {l}.", "Afspraak met {p} uit {l}."],
    "pt": ["Contacte {p} em {l}.", "{p} mora em {l}.", "Reunião com {p} de {l}."],
    "en": ["Please contact {p} in {l}.", "{p} lives in {l}.", "Meeting with {p} from {l}."],
}
ADDR_TPL = {
    "de": ["Anschrift: {a}.", "Lieferung an {a}."],
    "it": ["Indirizzo: {a}.", "Spedire a {a}."],
    "fr": ["Adresse : {a}.", "Livrer à {a}."],
    "es": ["Dirección: {a}.", "Enviar a {a}."],
    "nl": ["Adres: {a}.", "Bezorgen op {a}."],
    "pt": ["Endereço: {a}.", "Entregar em {a}."],
    "en": ["Address: {a}.", "Ship to {a}."],
}
ORG_TPL = {
    "de": ["Rechnung von der {o}.", "Auftrag an {o}."],
    "it": ["Fattura da {o}.", "Ordine a {o}."],
    "en": ["Invoice from {o}.", "Order to {o}."],
    "nl": ["Factuur van {o}.", "Order aan {o}."],
    "es": ["Factura de {o}.", "Pedido a {o}."],
}

Faker.seed(SEED)
random.seed(SEED)
cases: list[dict] = []


def add(lang, text, expected, i):
    cases.append(
        {
            "id": f"gen_{lang}_{len(cases)}",
            "text": text,
            "language": lang,
            "category": "eval",
            "split": "test" if i % 2 else "dev",
            "expected": expected,
        }
    )


N = 4
for lang, loc in LOCALES.items():
    fk = Faker(loc)
    for tpl in PL_TPL[lang]:
        for k in range(N):
            # first+last only (no Faker titles/suffixes like "Dr."/"B.Sc.", which
            # GLiNER omits -> would cause spurious misses under containment match).
            p, city = f"{fk.first_name()} {fk.last_name()}", fk.city()
            add(lang, tpl.format(p=p, l=city),
                [{"type": "PERSON", "text": p}, {"type": "LOCATION", "text": city}], k)
    for tpl in ADDR_TPL[lang]:
        for k in range(N):
            # Full address (street + postcode + city) so it reads like a real
            # address, not a bare street that looks like a location.
            a = f"{fk.street_address()}, {fk.postcode()} {fk.city()}".replace("\n", " ")
            add(lang, tpl.format(a=a), [{"type": "ADDRESS", "text": a}], k)
    for tpl in ORG_TPL.get(lang, []):
        for k in range(N):
            o = f"{fk.last_name()} {random.choice(ORG_WORD[lang])} {random.choice(ORG_SUFFIX[lang])}"
            add(lang, tpl.format(o=o), [{"type": "ORGANIZATION", "text": o}], k)
    for k in range(2):
        e = fk.email()
        add(lang, f"Mail: {e}", [{"type": "EMAIL_ADDRESS", "text": e}], k)
    for k in range(2):
        ib = fk.iban()
        # Faker's IBANs aren't always valid (e.g. es_ES fails mod-97); only keep
        # ones stdnum accepts, so a generator artifact isn't scored as a miss.
        if _iban.is_valid(ib):
            add(lang, f"IBAN {ib}", [{"type": "IBAN_CODE", "text": ib}], k)

with open(OUT, "w") as f:
    f.write("# AUTO-GENERATED by generate.py (Faker, seeded). category: eval (non-gating).\n")
    f.write("# Do not edit by hand; re-run the generator to refresh.\n")
    yaml.safe_dump({"test_cases": cases}, f, allow_unicode=True, sort_keys=False, width=10_000)

print(f"wrote {len(cases)} cases to {OUT}")
