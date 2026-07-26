"""Tests for semantic backend selection and model validation (no downloads)."""

from unittest.mock import Mock

import pytest
from httpx import Request, Response
from huggingface_hub.errors import (
    LocalEntryNotFoundError,
    RemoteEntryNotFoundError,
    RepositoryNotFoundError,
)

import detector.semantic_backend as semantic_backend
from detector.entities import PERSON, Span


@pytest.fixture(autouse=True)
def reset_semantic_backend(monkeypatch):
    monkeypatch.delenv("DETECTOR_BACKEND", raising=False)
    monkeypatch.delenv("DETECTOR_MODEL", raising=False)
    monkeypatch.delenv("DETECTOR_MODEL_PATH", raising=False)
    monkeypatch.setattr(semantic_backend, "_backend", None)


def _mock_gliner_loader(monkeypatch):
    load = Mock()
    monkeypatch.setattr(semantic_backend.gliner_layer, "load_model", load)
    return load


def _valid_local_model(path):
    path.mkdir(parents=True)
    (path / "gliner_config.json").write_text("{}")
    (path / "model.safetensors").touch()
    return path


def _hub_error(error_type):
    response = Response(404, request=Request("HEAD", "https://huggingface.co"))
    return error_type("not found", response=response)


def test_gliner_is_the_only_default_backend(monkeypatch):
    load = _mock_gliner_loader(monkeypatch)
    download_config = Mock()
    monkeypatch.setattr(semantic_backend, "hf_hub_download", download_config)

    backend = semantic_backend.load_semantic_backend()

    assert backend.name == "gliner"
    assert backend.model == "urchade/gliner_multi_pii-v1"
    load.assert_called_once_with("urchade/gliner_multi_pii-v1")
    download_config.assert_not_called()


def test_explicit_gliner_selection(monkeypatch):
    monkeypatch.setenv("DETECTOR_BACKEND", "gliner")
    load = _mock_gliner_loader(monkeypatch)

    semantic_backend.load_semantic_backend()

    load.assert_called_once_with("urchade/gliner_multi_pii-v1")


@pytest.mark.parametrize("backend", ["unknown", "openai_privacy_filter"])
def test_unknown_or_disabled_backend_fails_clearly(monkeypatch, backend):
    monkeypatch.setenv("DETECTOR_BACKEND", backend)
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(
        ValueError,
        match=rf"Unknown DETECTOR_BACKEND {backend!r}. Supported backends: gliner",
    ):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_selected_backend_loads_once(monkeypatch):
    load = _mock_gliner_loader(monkeypatch)

    first = semantic_backend.load_semantic_backend()
    second = semantic_backend.load_semantic_backend()

    assert first is second
    load.assert_called_once()


def test_valid_local_model_is_resolved_and_loaded(monkeypatch, tmp_path):
    model_path = _valid_local_model(tmp_path / "custom-checkpoint")
    monkeypatch.setenv("DETECTOR_MODEL", str(model_path))
    load = _mock_gliner_loader(monkeypatch)

    backend = semantic_backend.load_semantic_backend()

    assert backend.model == str(model_path.resolve())
    load.assert_called_once_with(str(model_path.resolve()))


def test_existing_relative_model_directory_shadows_hub_id(monkeypatch, tmp_path):
    model_path = _valid_local_model(tmp_path / "org" / "custom-gliner")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DETECTOR_MODEL", "org/custom-gliner")
    load = _mock_gliner_loader(monkeypatch)
    download_config = Mock()
    monkeypatch.setattr(semantic_backend, "hf_hub_download", download_config)

    semantic_backend.load_semantic_backend()

    load.assert_called_once_with(str(model_path.resolve()))
    download_config.assert_not_called()


def test_missing_local_model_path_fails_before_loading(monkeypatch, tmp_path):
    missing = tmp_path / "missing-model"
    monkeypatch.setenv("DETECTOR_MODEL", str(missing))
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(ValueError, match="DETECTOR_MODEL local path does not exist"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_unresolvable_tilde_model_fails_actionably(monkeypatch):
    model = "~unknown-pasteguard-user/custom-checkpoint"
    monkeypatch.setenv("DETECTOR_MODEL", model)
    monkeypatch.setattr(
        semantic_backend.Path,
        "expanduser",
        Mock(side_effect=RuntimeError("Could not determine home directory")),
    )
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(
        ValueError,
        match=r"DETECTOR_MODEL local path does not exist: ~unknown-pasteguard-user/",
    ):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_local_model_path_must_be_a_directory(monkeypatch, tmp_path):
    model_file = tmp_path / "model.bin"
    model_file.touch()
    monkeypatch.setenv("DETECTOR_MODEL", str(model_file))
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(ValueError, match="DETECTOR_MODEL local path is not a directory"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_local_model_requires_gliner_config(monkeypatch, tmp_path):
    model_path = tmp_path / "incomplete-checkpoint"
    model_path.mkdir()
    (model_path / "model.safetensors").touch()
    monkeypatch.setenv("DETECTOR_MODEL", str(model_path))
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(ValueError, match=r"missing gliner_config\.json"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_local_model_requires_valid_gliner_config(monkeypatch, tmp_path):
    model_path = tmp_path / "invalid-checkpoint"
    model_path.mkdir()
    (model_path / "gliner_config.json").write_text("not json")
    (model_path / "pytorch_model.bin").touch()
    monkeypatch.setenv("DETECTOR_MODEL", str(model_path))
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(ValueError, match=r"unreadable gliner_config\.json"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_local_model_requires_weights(monkeypatch, tmp_path):
    model_path = tmp_path / "incomplete-checkpoint"
    model_path.mkdir()
    (model_path / "gliner_config.json").write_text("{}")
    monkeypatch.setenv("DETECTOR_MODEL", str(model_path))
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(ValueError, match=r"missing model\.safetensors or pytorch_model\.bin"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_custom_hugging_face_model_is_validated_and_loaded(monkeypatch, tmp_path):
    config = tmp_path / "gliner_config.json"
    config.write_text("{}")
    monkeypatch.setenv("DETECTOR_MODEL", "org/custom-gliner")
    load = _mock_gliner_loader(monkeypatch)
    download_config = Mock(return_value=str(config))
    monkeypatch.setattr(semantic_backend, "hf_hub_download", download_config)

    semantic_backend.load_semantic_backend()

    download_config.assert_called_once_with("org/custom-gliner", "gliner_config.json")
    load.assert_called_once_with("org/custom-gliner")


def test_non_gliner_hugging_face_model_fails_before_loading(monkeypatch):
    monkeypatch.setenv("DETECTOR_MODEL", "org/token-classifier")
    load = _mock_gliner_loader(monkeypatch)
    monkeypatch.setattr(
        semantic_backend,
        "hf_hub_download",
        Mock(side_effect=_hub_error(RemoteEntryNotFoundError)),
    )

    with pytest.raises(ValueError, match="is not a GLiNER checkpoint"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_unknown_hugging_face_model_fails_actionably(monkeypatch):
    monkeypatch.setenv("DETECTOR_MODEL", "org/missing-model")
    load = _mock_gliner_loader(monkeypatch)
    monkeypatch.setattr(
        semantic_backend,
        "hf_hub_download",
        Mock(side_effect=_hub_error(RepositoryNotFoundError)),
    )

    with pytest.raises(ValueError, match="was not found or is not accessible"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_offline_uncached_model_fails_actionably(monkeypatch):
    monkeypatch.setenv("DETECTOR_MODEL", "org/custom-gliner")
    load = _mock_gliner_loader(monkeypatch)
    monkeypatch.setattr(
        semantic_backend,
        "hf_hub_download",
        Mock(side_effect=LocalEntryNotFoundError("not cached")),
    )

    with pytest.raises(ValueError, match="is not cached and Hugging Face is unavailable"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


@pytest.mark.parametrize("value", ["models/nested/path", "models/", "not a model!"])
def test_invalid_model_value_fails_before_loading(monkeypatch, value):
    monkeypatch.setenv("DETECTOR_MODEL", value)
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(ValueError, match="neither an existing local directory nor a valid"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_empty_model_env_uses_default(monkeypatch):
    monkeypatch.setenv("DETECTOR_MODEL", "")
    load = _mock_gliner_loader(monkeypatch)

    semantic_backend.load_semantic_backend()

    load.assert_called_once_with("urchade/gliner_multi_pii-v1")


def test_blank_model_env_fails_clearly(monkeypatch):
    monkeypatch.setenv("DETECTOR_MODEL", "   ")
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(ValueError, match="DETECTOR_MODEL must not be blank"):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_existing_model_path_alias_remains_supported(monkeypatch, tmp_path):
    model_path = _valid_local_model(tmp_path / "legacy-checkpoint")
    monkeypatch.setenv("DETECTOR_MODEL_PATH", str(model_path))
    load = _mock_gliner_loader(monkeypatch)

    semantic_backend.load_semantic_backend()

    load.assert_called_once_with(str(model_path.resolve()))


def test_existing_model_path_alias_wins_over_baked_detector_model(monkeypatch, tmp_path):
    model_path = _valid_local_model(tmp_path / "mounted-checkpoint")
    monkeypatch.setenv("DETECTOR_MODEL", "urchade/gliner_multi_pii-v1")
    monkeypatch.setenv("DETECTOR_MODEL_PATH", str(model_path))
    load = _mock_gliner_loader(monkeypatch)

    semantic_backend.load_semantic_backend()

    load.assert_called_once_with(str(model_path.resolve()))


def test_missing_model_path_alias_error_names_the_source(monkeypatch, tmp_path):
    missing = tmp_path / "missing-checkpoint"
    monkeypatch.setenv("DETECTOR_MODEL", "urchade/gliner_multi_pii-v1")
    monkeypatch.setenv("DETECTOR_MODEL_PATH", str(missing))
    load = _mock_gliner_loader(monkeypatch)

    with pytest.raises(
        ValueError,
        match="DETECTOR_MODEL_PATH local path does not exist",
    ):
        semantic_backend.load_semantic_backend()

    load.assert_not_called()


def test_backend_info_reports_loaded_identity(monkeypatch):
    _mock_gliner_loader(monkeypatch)

    assert semantic_backend.backend_info() == {}

    semantic_backend.load_semantic_backend()

    assert semantic_backend.backend_info() == {
        "backend": "gliner",
        "model": "urchade/gliner_multi_pii-v1",
    }


def test_detect_semantic_uses_loaded_backend(monkeypatch):
    _mock_gliner_loader(monkeypatch)
    expected = [Span(PERSON, 0, 5, 0.9)]
    detect = Mock(return_value=expected)
    monkeypatch.setattr(semantic_backend.gliner_layer, "detect_gliner", detect)

    assert semantic_backend.detect_semantic("Alice", 0.7) == expected
    detect.assert_called_once_with("Alice", 0.7)


def test_gliner_load_failure_includes_backend_and_model(monkeypatch):
    load = Mock(side_effect=OSError("weights are unreadable"))
    monkeypatch.setattr(semantic_backend.gliner_layer, "load_model", load)

    with pytest.raises(
        RuntimeError,
        match=(
            "Failed to load semantic backend 'gliner' with model "
            "'urchade/gliner_multi_pii-v1': OSError: weights are unreadable"
        ),
    ):
        semantic_backend.load_semantic_backend()

    assert semantic_backend.backend_info() == {}
