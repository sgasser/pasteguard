"""Semantic detector backend selection and model resolution."""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from huggingface_hub import hf_hub_download
from huggingface_hub.errors import (
    HfHubHTTPError,
    HFValidationError,
    LocalEntryNotFoundError,
    RemoteEntryNotFoundError,
    RepositoryNotFoundError,
)
from huggingface_hub.utils import (
    validate_repo_id,  # pyright: ignore[reportPrivateImportUsage]
)

from . import gliner_layer
from .entities import Span

DEFAULT_BACKEND = "gliner"
_GLINER_CONFIG = "gliner_config.json"
_GLINER_WEIGHTS = ("model.safetensors", "pytorch_model.bin")


class SemanticBackend(Protocol):
    """A loaded semantic detector with provider-neutral identity metadata."""

    @property
    def name(self) -> str: ...

    @property
    def model(self) -> str: ...

    def load(self) -> None: ...

    def detect(self, text: str, score_threshold: float = 0.0) -> list[Span]: ...


@dataclass(frozen=True)
class _FunctionBackend:
    name: str
    model: str
    _load_model: Callable[[str], None]
    _detect: Callable[[str, float], list[Span]]

    def load(self) -> None:
        self._load_model(self.model)

    def detect(self, text: str, score_threshold: float = 0.0) -> list[Span]:
        return self._detect(text, score_threshold)


@dataclass(frozen=True)
class _BackendDefinition:
    default_model: str
    resolve_model: Callable[[str, bool, str], str]
    build: Callable[[str], SemanticBackend]


def _build_gliner(model: str) -> SemanticBackend:
    return _FunctionBackend(
        name="gliner",
        model=model,
        _load_model=gliner_layer.load_model,
        _detect=gliner_layer.detect_gliner,
    )


_backend: SemanticBackend | None = None
_backend_lock = threading.Lock()


def _configured_model() -> tuple[str | None, str]:
    """Return the configured model and the environment variable that supplied it."""
    legacy_path = os.environ.get("DETECTOR_MODEL_PATH")
    if legacy_path:
        return legacy_path, "DETECTOR_MODEL_PATH"
    model = os.environ.get("DETECTOR_MODEL")
    return model or None, "DETECTOR_MODEL"


def _validate_gliner_config(config_path: Path, model: str, source_name: str) -> None:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(
            f"{source_name} {model!r} has an unreadable {_GLINER_CONFIG}: {exc}"
        ) from exc
    if not isinstance(config, dict):
        raise ValueError(
            f"{source_name} {model!r} has an invalid {_GLINER_CONFIG}: "
            "the top-level value must be an object"
        )


def _validate_local_gliner_model(path: Path, configured_value: str, source_name: str) -> str:
    if not path.is_dir():
        raise ValueError(f"{source_name} local path is not a directory: {configured_value}")

    config_path = path / _GLINER_CONFIG
    if not config_path.is_file():
        raise ValueError(
            f"{source_name} is not a complete GLiNER checkpoint: "
            f"missing {_GLINER_CONFIG} in {configured_value}"
        )
    _validate_gliner_config(config_path, configured_value, source_name)

    if not any((path / filename).is_file() for filename in _GLINER_WEIGHTS):
        expected = " or ".join(_GLINER_WEIGHTS)
        raise ValueError(
            f"{source_name} is not a complete GLiNER checkpoint: "
            f"missing {expected} in {configured_value}"
        )

    return str(path.resolve())


def _looks_like_local_path(value: str) -> bool:
    return value.startswith(("/", "./", "../", "~"))


def _validate_remote_gliner_model(model: str, source_name: str) -> None:
    try:
        config_path = Path(hf_hub_download(model, _GLINER_CONFIG))
    except RemoteEntryNotFoundError:
        raise ValueError(
            f"{source_name} {model!r} is not a GLiNER checkpoint: missing {_GLINER_CONFIG}"
        ) from None
    except RepositoryNotFoundError:
        raise ValueError(
            f"{source_name} {model!r} was not found or is not accessible; "
            "check the Hugging Face model ID and authentication"
        ) from None
    except LocalEntryNotFoundError:
        raise ValueError(
            f"{source_name} {model!r} could not be validated because "
            f"{_GLINER_CONFIG} is not cached and Hugging Face is unavailable"
        ) from None
    except HfHubHTTPError as exc:
        raise ValueError(
            f"{source_name} {model!r} could not be validated with Hugging Face: {exc}"
        ) from exc

    _validate_gliner_config(config_path, model, source_name)


def _resolve_gliner_model(
    configured_value: str,
    is_default: bool = False,
    source_name: str = "DETECTOR_MODEL",
) -> str:
    value = configured_value.strip()
    if not value:
        raise ValueError(f"{source_name} must not be blank")

    try:
        path = Path(value).expanduser()
    except RuntimeError:
        path = Path(value)
    if path.exists():
        return _validate_local_gliner_model(path, configured_value, source_name)
    if _looks_like_local_path(value):
        raise ValueError(f"{source_name} local path does not exist: {configured_value}")

    try:
        validate_repo_id(value)
    except HFValidationError:
        raise ValueError(
            f"{source_name} {configured_value!r} is neither an existing local "
            "directory nor a valid Hugging Face model ID"
        ) from None

    # The built-in checkpoint identity is known. Custom repositories are
    # checked before the much larger model download starts.
    if not is_default:
        _validate_remote_gliner_model(value, source_name)
    return value


_BACKENDS = {
    "gliner": _BackendDefinition(
        default_model=gliner_layer.DEFAULT_MODEL,
        resolve_model=_resolve_gliner_model,
        build=_build_gliner,
    )
}


def load_semantic_backend() -> SemanticBackend:
    """Resolve, validate, and load the configured semantic backend once."""
    global _backend
    if _backend is not None:
        return _backend

    with _backend_lock:
        if _backend is not None:
            return _backend

        backend_name = os.environ.get("DETECTOR_BACKEND", DEFAULT_BACKEND) or DEFAULT_BACKEND
        definition = _BACKENDS.get(backend_name)
        if definition is None:
            supported = ", ".join(sorted(_BACKENDS))
            raise ValueError(
                f"Unknown DETECTOR_BACKEND {backend_name!r}. Supported backends: {supported}"
            )

        configured_model, model_source = _configured_model()
        selected_model = configured_model or definition.default_model
        selected_model = definition.resolve_model(
            selected_model,
            configured_model is None or selected_model == definition.default_model,
            model_source,
        )

        backend = definition.build(selected_model)
        try:
            backend.load()
        except Exception as exc:
            raise RuntimeError(
                f"Failed to load semantic backend {backend.name!r} "
                f"with model {backend.model!r}: {type(exc).__name__}: {exc}"
            ) from exc

        _backend = backend
        return backend


def backend_info() -> dict[str, str]:
    """Return provider-neutral identity metadata for the loaded backend."""
    if _backend is None:
        return {}
    return {"backend": _backend.name, "model": _backend.model}


def detect_semantic(text: str, score_threshold: float = 0.0) -> list[Span]:
    """Run the configured semantic backend and return canonical spans."""
    return load_semantic_backend().detect(text, score_threshold)
