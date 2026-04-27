"""Cloud Function `wrap_chinese`: convert assistant chat content into HTML
that renders Chinese characters with stacked phonetic annotations.

POST { "content": "...", "use_fast_model": false }
  -> { "wrapped": "...", "model": "claude-opus-4-7" }

Cantonese runs are wrapped in <span class="zh-yue">…</span> so the Visual
Fonts (canto.hk) OpenType-SVG color font can render coloured contextual
jyutping above each character.

Mandarin runs are converted to inline <ruby>char<rt>pinyin</rt>…</ruby>
markup. The standalone pinyin line that was the source is deleted.

Driven by Claude on Anthropic Vertex AI (global region) — same channel as
the chat function. Defaults to Opus 4.7; pass use_fast_model=true for
Sonnet 4.6 (faster/cheaper, recommended for backfill).
"""

import functions_framework
from flask_cors import cross_origin

from anthropic import AnthropicVertex

from prompt import (
    SYSTEM_PROMPT,
    MODEL_DEFAULT,
    MODEL_FAST,
    MAX_TOKENS,
    PROJECT_ID,
    LOCATION,
)


_client = AnthropicVertex(region=LOCATION, project_id=PROJECT_ID)


def call_claude(content: str, use_fast_model: bool = False) -> tuple[str, str]:
    """Single non-streaming call to Claude. Returns (wrapped_text, model_id)."""
    model = MODEL_FAST if use_fast_model else MODEL_DEFAULT
    print(f"Calling Claude model={model} location={LOCATION} content_len={len(content)}")
    print(f"  full content payload: {content!r}")

    response = _client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content}],
    )

    parts = []
    for block in response.content:
        if getattr(block, "type", None) == "text":
            parts.append(block.text)
    wrapped = "".join(parts)

    usage = response.usage
    print(
        f"Claude returned wrapped_len={len(wrapped)} "
        f"input_tokens={usage.input_tokens} output_tokens={usage.output_tokens} "
        f"stop_reason={response.stop_reason}"
    )
    print(f"  full wrapped payload: {wrapped!r}")
    return wrapped, model


@functions_framework.http
@cross_origin()
def wrap_chinese(request):
    """HTTP function: POST {content, use_fast_model?} -> {wrapped, model}."""
    if request.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "3600",
        }
        return ("", 204, headers)

    try:
        request_json = request.get_json(silent=True) or {}
        print(f"Request payload keys: {list(request_json.keys())}")

        content = request_json.get("content")
        if content is None:
            return {"error": "content is required"}, 400
        if not isinstance(content, str):
            return {"error": "content must be a string"}, 400

        use_fast_model = bool(request_json.get("use_fast_model", False))

        if not content.strip():
            print("Empty content — returning empty wrapped")
            return {"wrapped": content, "model": None}, 200

        wrapped, model = call_claude(content, use_fast_model=use_fast_model)
        return {"wrapped": wrapped, "model": model}, 200

    except Exception as e:
        print(f"Error in wrap_chinese function: {str(e)}")
        return {"error": str(e)}, 500
