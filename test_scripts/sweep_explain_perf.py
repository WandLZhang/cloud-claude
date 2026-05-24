"""Parameter sweep for Explain Chinese books template performance.

Calls the Vertex SDK directly (bypassing cloud function) with the same image
from the last chat, varying: model x thinking x web_search. Times each, dumps
output to disk for quality comparison.

Usage:
    source functions/chat/.venv/bin/activate
    python test_scripts/sweep_explain_perf.py
"""

import base64
import json
import os
import time
import urllib.request

import firebase_admin
from anthropic import AnthropicVertex
from firebase_admin import firestore

PROJECT = "wz-cloud-claude"
REGION = "global"
USER_ID = "xoBY9nLz8ObwvIRPdJ855EBmAlv2"
CHAT_ID = "exzZ2HX2qEaZQFJ3nf4G"
TEMPLATE_ID = "eZjPcdorX2KEfEZuKTLX"
OUTPUT_DIR = "/tmp/explain_sweep"

# We test these param combinations (model x thinking x web_search)
# Max tokens set generously so thinking doesn't eat the output budget
COMBOS = [
    # (model, thinking, web, max_tokens, label)
    ("claude-sonnet-4-6", False, False, 16384, "sonnet_nothink_noweb"),
    ("claude-sonnet-4-6", False, True,  16384, "sonnet_nothink_web"),
    ("claude-sonnet-4-6", True,  False, 32768, "sonnet_think_noweb"),
    ("claude-sonnet-4-6", True,  True,  32768, "sonnet_think_web"),
    ("claude-opus-4-7",   False, False, 16384, "opus47_nothink_noweb"),
    ("claude-opus-4-7",   False, True,  16384, "opus47_nothink_web"),
    ("claude-opus-4-7",   True,  False, 32768, "opus47_think_noweb"),
    ("claude-opus-4-7",   True,  True,  32768, "opus47_think_web"),
]


def fetch_chat_state():
    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": PROJECT})
    db = firestore.client()
    chat_ref = db.collection("chats").document(USER_ID).collection("conversations").document(CHAT_ID)
    msgs = list(chat_ref.collection("messages").order_by("timestamp").stream())

    # Get image URL from second user message
    image_url = None
    for m in msgs:
        d = m.to_dict()
        if d.get("role") == "user" and "image" in d:
            image_url = d["image"]["url"]
            break
    if not image_url:
        raise RuntimeError("No image in chat")

    # Pull system prompt from the template (latest version)
    template = db.collection("prompts").document(USER_ID).collection("userPrompts").document(TEMPLATE_ID).get().to_dict()
    sys_prompt = template["systemPrompt"]

    # Pull conversation context
    convo = []
    for m in msgs:
        d = m.to_dict()
        role = d.get("role")
        if role == "user":
            convo.append({"role": "user", "content": d.get("content", "")})
        elif role == "assistant" and d.get("content"):
            convo.append({"role": "assistant", "content": d.get("content", "")})
    return image_url, sys_prompt, convo[:2]  # first 2 turns, then we add image


def b64_of_url(url):
    with urllib.request.urlopen(url) as resp:
        return base64.standard_b64encode(resp.read()).decode()


def run_one(client, image_b64, sys_prompt, prior_turns, model, thinking, web, max_tokens, label):
    print(f"\n{'='*60}")
    print(f"[{label}] model={model} thinking={thinking} web={web} max_tokens={max_tokens}")

    messages = list(prior_turns) + [{
        "role": "user",
        "content": [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}}]
    }]

    kwargs = dict(
        model=model,
        max_tokens=max_tokens,
        system=[{"type": "text", "text": sys_prompt}],
        messages=messages,
    )
    if thinking:
        kwargs["thinking"] = {"type": "adaptive"}
        if "opus-4-7" in model:
            kwargs["output_config"] = {"effort": "max"}
    if web:
        kwargs["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}]

    text = ""
    thinking_text = ""
    web_count = 0
    first_chunk_at = None
    start = time.time()

    try:
        with client.messages.stream(**kwargs) as stream:
            for event in stream:
                etype = getattr(event, "type", None)
                if etype == "content_block_delta" and hasattr(event, "delta"):
                    if hasattr(event.delta, "text"):
                        if first_chunk_at is None:
                            first_chunk_at = time.time() - start
                        text += event.delta.text
                    elif hasattr(event.delta, "thinking"):
                        thinking_text += event.delta.thinking
                elif etype == "content_block_start" and hasattr(event, "content_block"):
                    if getattr(event.content_block, "type", "") == "server_tool_use":
                        web_count += 1
            msg = stream.current_message_snapshot
            stop_reason = msg.stop_reason
            usage = {
                "input_tokens": msg.usage.input_tokens,
                "output_tokens": msg.usage.output_tokens,
                "cache_read": getattr(msg.usage, "cache_read_input_tokens", 0),
            }
    except Exception as e:
        elapsed = time.time() - start
        print(f"  ERROR after {elapsed:.1f}s: {e}")
        return {
            "label": label, "model": model, "thinking": thinking, "web": web,
            "elapsed": elapsed, "error": str(e), "text": "",
        }

    elapsed = time.time() - start
    has_zhcmn = 'class="zh-cmn"' in text
    has_english = bool(text and any(kw in text for kw in ["English", "—", " — ", "  ", "\n\n"]))

    result = {
        "label": label, "model": model, "thinking": thinking, "web": web,
        "max_tokens": max_tokens,
        "elapsed": elapsed,
        "ttft": first_chunk_at,
        "stop_reason": stop_reason,
        "usage": usage,
        "text_chars": len(text),
        "thinking_chars": len(thinking_text),
        "web_search_count": web_count,
        "has_zh_cmn": has_zhcmn,
        "has_english_sections": has_english,
    }

    print(f"  elapsed={elapsed:.1f}s ttft={first_chunk_at:.1f}s" if first_chunk_at else f"  elapsed={elapsed:.1f}s ttft=N/A")
    print(f"  stop={stop_reason}  text={len(text)}ch  thinking={len(thinking_text)}ch  webs={web_count}")
    print(f"  usage={usage}")
    print(f"  zh-cmn={has_zhcmn}")

    # Save full output
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(f"{OUTPUT_DIR}/{label}.md", "w") as f:
        f.write(f"# {label}\n\n")
        f.write(f"Config: model={model}  thinking={thinking}  web={web}  max_tokens={max_tokens}\n")
        f.write(f"Elapsed: {elapsed:.1f}s  TTFT: {first_chunk_at:.1f}s\n" if first_chunk_at else "")
        f.write(f"Stop reason: {stop_reason}\n")
        f.write(f"Usage: {json.dumps(usage)}\n")
        f.write(f"Web searches: {web_count}\n\n")
        f.write("---\n\n## Output\n\n")
        f.write(text)
        if thinking_text:
            f.write("\n\n---\n\n## Thinking\n\n")
            f.write(thinking_text)

    return result


def main():
    print("Fetching chat state...")
    image_url, sys_prompt, prior = fetch_chat_state()
    print(f"  Image: {image_url[:80]}...")
    print(f"  System prompt: {len(sys_prompt)} chars")
    print(f"  Prior turns: {len(prior)}")

    print("\nDownloading image...")
    image_b64 = b64_of_url(image_url)
    print(f"  Image: {len(image_b64)} chars base64")

    client = AnthropicVertex(region=REGION, project_id=PROJECT)

    results = []
    for combo in COMBOS:
        model, thinking, web, max_tokens, label = combo
        try:
            r = run_one(client, image_b64, sys_prompt, prior, model, thinking, web, max_tokens, label)
            results.append(r)
        except Exception as e:
            print(f"  TOP-LEVEL ERROR: {e}")
            results.append({"label": label, "error": str(e)})

    # Summary
    print(f"\n\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")
    print(f"{'Label':<25} {'Time':>7} {'TTFT':>6} {'Text':>6} {'Think':>6} {'Stop':>14}")
    print("-" * 70)
    for r in results:
        if "error" in r and "elapsed" not in r:
            print(f"{r['label']:<25} ERROR: {r['error'][:40]}")
            continue
        ttft = f"{r.get('ttft', 0):.1f}s" if r.get('ttft') else "N/A"
        print(f"{r['label']:<25} {r['elapsed']:>6.1f}s {ttft:>6} {r.get('text_chars',0):>6} {r.get('thinking_chars',0):>6} {str(r.get('stop_reason',''))[:14]:>14}")

    with open(f"{OUTPUT_DIR}/results.json", "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\nFull results: {OUTPUT_DIR}/results.json")
    print(f"Per-config outputs: {OUTPUT_DIR}/*.md")


if __name__ == "__main__":
    main()
