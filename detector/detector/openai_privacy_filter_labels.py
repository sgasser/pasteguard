"""Label validation and canonical entity mapping for OpenAI Privacy Filter."""

from __future__ import annotations

import re
from collections.abc import Mapping

from .entities import (
    ACCOUNT_NUMBER,
    CREDIT_CARD,
    DATE_TIME,
    EMAIL_ADDRESS,
    IBAN_CODE,
    IP_ADDRESS,
    LOCATION,
    PERSON,
    PHONE_NUMBER,
    SECRET,
    URL,
    VAT_CODE,
)

BOUNDARY_RE = re.compile(r"^([BIES])-(.+)$")
_LABEL_RE = re.compile(r"^([^-]+)-(.+)$")
_SUPPORTED_BOUNDARIES = frozenset({"B", "I", "E", "S"})

# The default checkpoint's eight native categories are required for
# compatibility. Extra categories are allowed: recognized aliases are mapped
# below and all other labels are intentionally ignored.
REQUIRED_LABELS = frozenset(
    {
        "account_number",
        "private_address",
        "private_date",
        "private_email",
        "private_person",
        "private_phone",
        "private_url",
        "secret",
    }
)

LABEL_TO_TYPE = {
    # Native OpenAI Privacy Filter labels.
    "account_number": ACCOUNT_NUMBER,
    "private_address": LOCATION,
    "private_date": DATE_TIME,
    "private_email": EMAIL_ADDRESS,
    "private_person": PERSON,
    "private_phone": PHONE_NUMBER,
    "private_url": URL,
    "secret": SECRET,
    # Canonical aliases accepted from compatible fine-tunes. These are not
    # emitted as distinct categories by the default checkpoint.
    "person": PERSON,
    "location": LOCATION,
    "email_address": EMAIL_ADDRESS,
    "phone_number": PHONE_NUMBER,
    "credit_card": CREDIT_CARD,
    "iban_code": IBAN_CODE,
    "ip_address": IP_ADDRESS,
    "url": URL,
    "date_time": DATE_TIME,
    "vat_code": VAT_CODE,
}


def label_state(raw_label: str) -> tuple[str | None, str | None]:
    match = BOUNDARY_RE.fullmatch(raw_label)
    if match is None:
        return None, None
    boundary, native_label = match.groups()
    if native_label not in LABEL_TO_TYPE:
        return None, None
    return boundary, native_label


def _normalized_id2label(raw: object) -> dict[int, str]:
    if not isinstance(raw, Mapping):
        return {}

    labels: dict[int, str] = {}
    for raw_id, raw_label in raw.items():
        if isinstance(raw_id, bool) or not isinstance(raw_label, str):
            continue
        try:
            label_id = int(raw_id)
        except (TypeError, ValueError, OverflowError):
            continue
        if label_id < 0 or not raw_label:
            continue
        labels[label_id] = raw_label
    return labels


def validate_label_set(id2label: object, model_name: str) -> dict[int, str]:
    """Validate and normalize a Privacy Filter-compatible label mapping."""

    labels = _normalized_id2label(id2label)
    raw_names = set(labels.values())
    if "O" not in raw_names:
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} is not a Privacy Filter-compatible "
            "checkpoint: its labels are missing O"
        )

    boundaries: dict[str, set[str]] = {}
    for raw_label in raw_names:
        match = _LABEL_RE.fullmatch(raw_label)
        if match is None:
            continue
        boundary, native_label = match.groups()
        boundaries.setdefault(native_label, set()).add(boundary)

    unsupported_boundaries = sorted(
        (label, tags - _SUPPORTED_BOUNDARIES)
        for label, tags in boundaries.items()
        if label in LABEL_TO_TYPE and tags - _SUPPORTED_BOUNDARIES
    )
    if unsupported_boundaries:
        details = ", ".join(
            f"{label}={','.join(sorted(tags))}" for label, tags in unsupported_boundaries
        )
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} is not a Privacy Filter-compatible "
            f"checkpoint: unsupported boundary prefixes ({details}); "
            "expected BIO or BIOES labels"
        )

    missing = sorted(REQUIRED_LABELS - boundaries.keys())
    if missing:
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} is not a Privacy Filter-compatible "
            f"checkpoint: its labels are missing {', '.join(missing)}"
        )

    invalid_schemes = sorted(
        label
        for label in REQUIRED_LABELS
        if boundaries[label] not in ({"B", "I"}, _SUPPORTED_BOUNDARIES)
    )
    if invalid_schemes:
        details = ", ".join(
            f"{label}={','.join(sorted(boundaries[label]))}" for label in invalid_schemes
        )
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} is not a Privacy Filter-compatible "
            f"checkpoint: incomplete BIO/BIOES boundaries ({details})"
        )
    return labels
