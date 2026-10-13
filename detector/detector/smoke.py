"""Exercise real detector startup and inference during the runtime image build."""

import asyncio

from .app import AnalyzeRequest, analyze, app, health
from .entities import EMAIL_ADDRESS, LOCATION


async def main() -> None:
    async with app.router.lifespan_context(app):
        if health().get("backend") != "gliner":
            raise RuntimeError("The runtime image must start the GLiNER backend")

        text = "I live in Berlin. Email me at alice@example.com."
        entities = analyze(AnalyzeRequest(text=text))
        for entity_type, value in (
            (EMAIL_ADDRESS, "alice@example.com"),
            (LOCATION, "Berlin"),
        ):
            if not any(
                entity.entity_type == entity_type and text[entity.start : entity.end] == value
                for entity in entities
            ):
                raise RuntimeError(f"Runtime inference did not detect {entity_type}: {value}")

    print("Detector runtime smoke check passed (GLiNER startup and inference)")


if __name__ == "__main__":
    asyncio.run(main())
