#!/bin/bash
set -e

# Runtime language override via environment variable
# Note: Can only RESTRICT to languages already installed in the image
# Example: docker run -e PASTEGUARD_LANGUAGES=en,de ghcr.io/sgasser/pasteguard:eu
if [ -n "$PASTEGUARD_LANGUAGES" ]; then
  echo "[ENTRYPOINT] Overriding languages: $PASTEGUARD_LANGUAGES"
  python3 << EOF
import yaml
import sys

requested = [lang.strip() for lang in "$PASTEGUARD_LANGUAGES".split(",")]
config_path = "/app/config.yaml"
nlp_config_path = "/usr/bin/presidio_analyzer/conf/default.yaml"

# Read installed languages from Presidio NLP config
with open(nlp_config_path) as f:
    nlp_config = yaml.safe_load(f)
installed = [m["lang_code"] for m in nlp_config.get("models", [])]

# Check for unavailable languages
unavailable = [lang for lang in requested if lang not in installed]
if unavailable:
    print(f"[ENTRYPOINT] WARNING: Languages not installed in this image: {unavailable}")
    print(f"[ENTRYPOINT] Available languages: {installed}")
    print(f"[ENTRYPOINT] Use the EU image or build custom for more languages")
    # Filter to only available languages
    requested = [lang for lang in requested if lang in installed]
    if not requested:
        print(f"[ENTRYPOINT] ERROR: No valid languages remaining, using installed: {installed}")
        requested = installed

# Update app config
with open(config_path) as f:
    config = yaml.safe_load(f)

config["pii_detection"]["languages"] = requested

with open(config_path, "w") as f:
    yaml.dump(config, f, default_flow_style=False, sort_keys=False)

print(f"[ENTRYPOINT] Languages set to: {requested}")
EOF
fi

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/pasteguard.conf
