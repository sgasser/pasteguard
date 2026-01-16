#!/usr/bin/env python3
"""
Generate Presidio configuration files from selected languages.

Usage:
    python generate-configs.py --languages=en,de --output=/output

Reads from languages.yaml and generates:
    - nlp-config.yaml
    - recognizers-config.yaml
    - analyzer-config.yaml
    - install-models.sh
"""

import argparse
import sys
from pathlib import Path

import yaml


def load_registry(registry_path: Path) -> dict:
    """Load the language registry."""
    with open(registry_path) as f:
        return yaml.safe_load(f)


def validate_languages(languages: list[str], registry: dict) -> list[str]:
    """Validate requested languages exist in registry."""
    available = set(registry["languages"].keys())
    valid = []
    invalid = []

    for lang in languages:
        if lang in available:
            valid.append(lang)
        else:
            invalid.append(lang)

    if invalid:
        print(f"Error: Unknown language(s): {', '.join(invalid)}", file=sys.stderr)
        print(f"Available: {', '.join(sorted(available))}", file=sys.stderr)
        sys.exit(1)

    return valid


def generate_nlp_config(languages: list[str], registry: dict) -> dict:
    """Generate nlp-config.yaml content."""
    models = []
    for lang in languages:
        lang_config = registry["languages"][lang]
        models.append({"lang_code": lang, "model_name": lang_config["model"]})

    return {
        "nlp_engine_name": "spacy",
        "models": models,
        "ner_model_configuration": {
            "model_to_presidio_entity_mapping": {
                # Standard labels (most languages)
                "PER": "PERSON",
                "PERSON": "PERSON",
                "LOC": "LOCATION",
                "GPE": "LOCATION",
                "ORG": "ORGANIZATION",
                # Polish (NKJP corpus)
                "persName": "PERSON",
                "placeName": "LOCATION",
                "geogName": "LOCATION",
                "orgName": "ORGANIZATION",
                # Korean
                "PS": "PERSON",
                "LC": "LOCATION",
                "OG": "ORGANIZATION",
                # Swedish
                "PRS": "PERSON",
                # Norwegian
                "GPE_LOC": "LOCATION",
            },
            "low_confidence_score_multiplier": 0.4,
            "low_score_entity_names": ["ORG"],
            "labels_to_ignore": [
                "O",
                "CARDINAL",
                "EVENT",
                "LANGUAGE",
                "LAW",
                "MONEY",
                "ORDINAL",
                "PERCENT",
                "PRODUCT",
                "QUANTITY",
                "WORK_OF_ART",
            ],
        },
    }


def generate_analyzer_config(languages: list[str]) -> dict:
    """Generate analyzer-config.yaml content."""
    return {"supported_languages": languages, "default_score_threshold": 0}


def generate_recognizers_config(languages: list[str], registry: dict) -> dict:
    """Generate recognizers-config.yaml content."""
    # Build language entries for each recognizer type
    spacy_langs = [{"language": lang} for lang in languages]

    # Phone recognizer needs context words per language
    phone_langs = []
    for lang in languages:
        lang_config = registry["languages"][lang]
        entry = {"language": lang}
        if "phone_context" in lang_config:
            entry["context"] = lang_config["phone_context"]
        phone_langs.append(entry)

    return {
        "supported_languages": languages,
        "global_regex_flags": 26,
        "recognizers": [
            {
                "name": "SpacyRecognizer",
                "supported_languages": spacy_langs,
                "type": "predefined",
            },
            {
                "name": "EmailRecognizer",
                "supported_languages": spacy_langs,
                "type": "predefined",
            },
            {
                "name": "PhoneRecognizer",
                "supported_languages": phone_langs,
                "type": "predefined",
            },
            {
                "name": "CreditCardRecognizer",
                "supported_languages": spacy_langs,
                "type": "predefined",
            },
            {
                "name": "IbanRecognizer",
                "supported_languages": spacy_langs,
                "type": "predefined",
            },
            {
                "name": "IpRecognizer",
                "supported_languages": spacy_langs,
                "type": "predefined",
            },
        ],
    }


def generate_install_script(languages: list[str], registry: dict) -> str:
    """Generate shell script to install spaCy models."""
    version = registry["spacy_version"]
    lines = ["#!/bin/sh", "set -e", ""]

    for lang in languages:
        model = registry["languages"][lang]["model"]
        url = f"https://github.com/explosion/spacy-models/releases/download/{model}-{version}/{model}-{version}-py3-none-any.whl"
        lines.append(f'echo "Installing {model} for {lang}..."')
        # Use poetry run pip to install in the correct virtual environment
        lines.append(f"poetry run pip install --no-cache-dir {url}")
        lines.append("")

    lines.append('echo "All models installed successfully"')
    return "\n".join(lines)


def write_yaml(data: dict, path: Path) -> None:
    """Write data to YAML file."""
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def main():
    parser = argparse.ArgumentParser(description="Generate Presidio configs")
    parser.add_argument(
        "--languages",
        required=True,
        help="Comma-separated list of language codes (e.g., en,de,fr)",
    )
    parser.add_argument(
        "--registry",
        default="/build/languages.yaml",
        help="Path to languages.yaml registry",
    )
    parser.add_argument(
        "--output", default="/output", help="Output directory for generated files"
    )
    args = parser.parse_args()

    # Parse languages
    languages = [lang.strip() for lang in args.languages.split(",") if lang.strip()]
    if not languages:
        print("Error: No languages specified", file=sys.stderr)
        sys.exit(1)

    # Load registry
    registry_path = Path(args.registry)
    if not registry_path.exists():
        print(f"Error: Registry not found: {registry_path}", file=sys.stderr)
        sys.exit(1)

    registry = load_registry(registry_path)

    # Validate languages
    languages = validate_languages(languages, registry)

    # Create output directory
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Generate configs
    print(f"Generating configs for: {', '.join(languages)}")

    nlp_config = generate_nlp_config(languages, registry)
    write_yaml(nlp_config, output_dir / "nlp-config.yaml")
    print(f"  - nlp-config.yaml")

    analyzer_config = generate_analyzer_config(languages)
    write_yaml(analyzer_config, output_dir / "analyzer-config.yaml")
    print(f"  - analyzer-config.yaml")

    recognizers_config = generate_recognizers_config(languages, registry)
    write_yaml(recognizers_config, output_dir / "recognizers-config.yaml")
    print(f"  - recognizers-config.yaml")

    install_script = generate_install_script(languages, registry)
    install_path = output_dir / "install-models.sh"
    with open(install_path, "w") as f:
        f.write(install_script)
    install_path.chmod(0o755)
    print(f"  - install-models.sh")

    print("Done!")


if __name__ == "__main__":
    main()
