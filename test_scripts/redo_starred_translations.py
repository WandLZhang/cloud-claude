"""Redo starred translation chats with the current Firestore templates +
words.hk methodology. Replaces assistant messages inline; original content is
preserved in `contentBeforeRedo` on each message.

The first user message in each chat (the original instruction) is also replaced
with the current template content, with the original stashed in
`contentBeforeRedo` on that message too.

Sets `enableWebSearch: true` on the chat doc so future turns also search.

Usage:
    source .venv/bin/activate
    python test_scripts/redo_starred_translations.py --project wz-cloud-claude --chat <id>
    python test_scripts/redo_starred_translations.py --project wz-cloud-claude --all --workers 4

Flags:
    --chat ID          Process a single chat by ID (recommended for first sample)
    --all              Process all known starred translation chats
    --workers N        Concurrent chats (default 4)
    --dry-run          Don't write to Firestore; just show what would happen
    --skip-done        Skip chats whose first user msg already has contentBeforeRedo
"""

import argparse
import concurrent.futures as cf
import json
import re
import sys
import time
import urllib.request

import firebase_admin
from firebase_admin import firestore

PROJECT_ID = "wz-cloud-claude"
CLOUD_FUNCTION_URL = "https://us-east4-wz-cloud-claude.cloudfunctions.net/chat"
USER_ID = "xoBY9nLz8ObwvIRPdJ855EBmAlv2"

# Saved-prompt template IDs (Firestore)
TEMPLATE_MANDARIN_BOOKS = "g8QTqrl3O40ex8pmBSvf"
TEMPLATE_ENGLISH_BOOKS = "K731ZzMJXnlP85BNCFmY"

# Starred translation chats to redo
TARGET_CHATS = [
    "uFkek4xdqW0bpVXFIZYo",   # 青蛙王子 (5 turns)
    "EIbs9DhzpQNXaLgd3KvG",   # 木偶奇遇记 (16 turns)
    "2USIh8qzvFqNZWH6R9RP",   # 启蒙大卡 - 好听儿歌 (32 turns)
    "Tf5l372pNGMannQ4Pejm",   # 好孩子好习惯 - 心灵卷 (65 turns)
    "nAkFIIViouo8QokUNVny",   # 好孩子好习惯（成长卷）(69 turns)
    "IknSfGmnfxnw1TF5qAgJ",   # 好孩子好习惯 - 智慧卷 (76 turns)
    "Pf3OPHuyHFdg8s1RQjhd",   # Play with Mickey (14 turns) — EN→ZH
    "6LsbhyaAqfQxVn5Eg01R",   # Play With Minnie (11 turns) — EN→ZH
]

# Mirror frontend's CHINESE_FORMAT_SUFFIX so the per-request system prompt
# matches what the deployed app sends.
DEFAULT_SYSTEM_PROMPT = """You are Claude, a helpful AI assistant. Engage in natural conversation,
be helpful, harmless, and honest. Provide thoughtful and detailed responses when appropriate."""

CHINESE_FORMAT_SUFFIX = """

When your response includes Cantonese or Mandarin pinyin, format them with HTML wrappers so the UI can render them correctly:

CANTONESE:
- Wrap each Cantonese Chinese-character line/clause in <span class="zh-yue">…</span>
- Do NOT output jyutping romanization — the font renders it visually above the characters
- Example:
  <span class="zh-yue">從前，喺一個好遠嘅國度</span>

MANDARIN (pinyin = diacritics like nǐ hǎo):
- Convert to inline <ruby> tags, one <rt> per character. DELETE the standalone pinyin line.
- Example: <ruby>你<rt>nǐ</rt>好<rt>hǎo</rt></ruby>
- For interleaved format (鸟niǎo儿ér), also convert: <ruby>鸟<rt>niǎo</rt>儿<rt>ér</rt></ruby>

BOTH in one response:
  **Mandarin:** <ruby>你<rt>nǐ</rt>好<rt>hǎo</rt></ruby>
  **Cantonese:**
  <span class="zh-yue">你好</span>

If no Chinese characters in the response, ignore these rules entirely."""

CHINESE_REGEX = re.compile(r'mandarin|cantonese|pinyin|jyutping|粵|普通話|广东话|翻译|翻譯', re.IGNORECASE)
JYUTPING_RE = re.compile(r'\b[a-z]{1,6}[1-6]\b')
HK_DISTINCT_RE = re.compile(r'[嘅喺哋佢啲咗嚟嘢㗎咩嗰噉諗唔係冇俾]')
CJK_RE = re.compile(r'[一-鿿]')


def detect_template_id(first_user_content: str) -> str:
    """Return the Firestore template ID matching this chat's source language."""
    if "in English you will translate" in first_user_content:
        return TEMPLATE_ENGLISH_BOOKS
    return TEMPLATE_MANDARIN_BOOKS


def programmatic_safety_wrap(content: str) -> str:
    """Same logic as the deployed messageService.js safety net.
    If the content has CJK + HK-distinctive chars but no wrapper, wrap each
    Chinese-bearing paragraph in <span class="zh-yue">."""
    if not content:
        return content
    has_wrapper = 'class="zh-yue"' in content or '<ruby>' in content or '<rt>' in content
    has_hk = bool(HK_DISTINCT_RE.search(content))
    if has_wrapper or not has_hk:
        return content
    paragraphs = re.split(r'\n\n+', content)
    wrapped = []
    for para in paragraphs:
        if CJK_RE.search(para):
            wrapped.append(f'<span class="zh-yue">{para}</span>')
        else:
            wrapped.append(para)
    return '\n\n'.join(wrapped)


def call_chat(api_messages, system_prompt, image=None, web_search=True, timeout=600):
    """POST to cloud function and parse SSE stream. Returns dict with content, web_queries, citations."""
    payload = {
        "messages": api_messages,
        "system_prompt": system_prompt,
        "use_cache": True,
        "enable_web_search": web_search,
    }
    if image:
        payload["image"] = {"url": image["url"], "type": image.get("type", "image/jpeg")}

    req = urllib.request.Request(
        CLOUD_FUNCTION_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        response_text = resp.read().decode()

    out = {"content": None, "web_queries": None, "citations": None, "usage": {}}
    for line in response_text.split("\n"):
        if not line.startswith("data: "):
            continue
        try:
            data = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        if data.get("type") == "done":
            out["content"] = data.get("content", "")
            out["web_queries"] = data.get("web_search_queries")
            out["citations"] = data.get("citations")
            out["usage"] = data.get("usage", {})
    return out


def process_chat(db, chat_id, dry_run=False, skip_done=False, log_prefix=""):
    """Replay a single chat. Sequential — accumulates conversation history.
    Returns dict with stats."""
    chat_ref = db.collection("chats").document(USER_ID).collection("conversations").document(chat_id)
    chat_doc = chat_ref.get().to_dict() or {}
    title = chat_doc.get("title", "(untitled)")

    msgs_snap = list(chat_ref.collection("messages").order_by("timestamp").stream())
    msgs = [(m, m.to_dict() or {}) for m in msgs_snap]
    if not msgs:
        return {"chat_id": chat_id, "skipped": True, "reason": "no messages"}

    # Detect language from first user message
    first_user = next(((s, d) for s, d in msgs if d.get("role") == "user"), None)
    if not first_user:
        return {"chat_id": chat_id, "skipped": True, "reason": "no user msg"}
    first_user_snap, first_user_data = first_user
    orig_first_content = first_user_data.get("content", "")

    # Skip-done check
    if skip_done and "contentBeforeRedo" in first_user_data:
        return {"chat_id": chat_id, "skipped": True, "reason": "already redone"}

    template_id = detect_template_id(orig_first_content)
    template_doc = db.collection("prompts").document(USER_ID).collection("userPrompts").document(template_id).get().to_dict()
    if not template_doc:
        return {"chat_id": chat_id, "skipped": True, "reason": f"template {template_id} not found"}
    new_first_content = template_doc.get("content", "")
    if not new_first_content:
        return {"chat_id": chat_id, "skipped": True, "reason": "empty template"}

    print(f"{log_prefix}[{chat_id[:10]}] '{title}' ({len(msgs)} msgs, lang_template={template_id})")
    sys.stdout.flush()

    # Update first user message
    if not dry_run:
        first_user_snap.reference.update({
            "content": new_first_content,
            "contentBeforeRedo": orig_first_content,
        })

    # Walk all messages, replay user messages, replace assistant messages
    conversation_history = []  # for cloud function payload
    user_msgs_in_order = [(s, d) for s, d in msgs if d.get("role") == "user"]
    asst_msgs_in_order = [(s, d) for s, d in msgs if d.get("role") == "assistant"]

    stats = {
        "chat_id": chat_id, "title": title, "skipped": False,
        "user_msgs": len(user_msgs_in_order), "asst_msgs_processed": 0,
        "errors": 0, "jyutping_leaks": 0, "web_search_turns": 0, "total_searches": 0,
    }

    asst_idx = 0
    for u_idx, (u_snap, u_data) in enumerate(user_msgs_in_order):
        # Use updated content for first user msg, original content for rest
        content = new_first_content if u_idx == 0 else u_data.get("content", "")
        image = u_data.get("image")

        # Append to history & build api payload
        api_msg = {"role": "user", "content": content}
        if image:
            api_msg["image"] = {"url": image["url"], "type": image.get("type", "image/jpeg")}

        api_messages = list(conversation_history) + [api_msg]

        # System prompt — mirror frontend logic
        prompt_lower = (DEFAULT_SYSTEM_PROMPT + " " + content).lower()
        is_chinese = bool(CHINESE_REGEX.search(prompt_lower))
        sys_prompt = DEFAULT_SYSTEM_PROMPT + CHINESE_FORMAT_SUFFIX if is_chinese else DEFAULT_SYSTEM_PROMPT

        # Determine which assistant message corresponds to this user turn
        # The original chat's order is u, a, u, a, ... so asst follows user.
        # We index assistant messages by position in their own list.
        # If a user turn has no following assistant in original (rare), skip update.
        if asst_idx >= len(asst_msgs_in_order):
            print(f"{log_prefix}  [{chat_id[:10]}] turn {u_idx+1}: no assistant msg to replace, skipping")
            sys.stdout.flush()
            continue

        a_snap, a_data = asst_msgs_in_order[asst_idx]
        old_asst_content = a_data.get("content", "")

        # Call cloud function
        try:
            print(f"{log_prefix}  [{chat_id[:10]}] turn {u_idx+1}/{len(user_msgs_in_order)} → API call (image={bool(image)})")
            sys.stdout.flush()
            result = call_chat(api_messages, sys_prompt, image=image, web_search=True)
        except Exception as e:
            print(f"{log_prefix}  [{chat_id[:10]}] turn {u_idx+1} ERROR: {e}")
            sys.stdout.flush()
            stats["errors"] += 1
            asst_idx += 1
            continue

        new_asst_content = result.get("content") or ""
        if not new_asst_content:
            print(f"{log_prefix}  [{chat_id[:10]}] turn {u_idx+1} EMPTY response, skipping write")
            sys.stdout.flush()
            stats["errors"] += 1
            asst_idx += 1
            continue

        # Apply programmatic safety wrap (same as deployed frontend)
        new_asst_content = programmatic_safety_wrap(new_asst_content)

        # Track stats
        if JYUTPING_RE.search(new_asst_content):
            stats["jyutping_leaks"] += 1
        if result.get("web_queries"):
            stats["web_search_turns"] += 1
            stats["total_searches"] += len(result["web_queries"])

        usage = result.get("usage", {})
        wq_short = (result.get("web_queries") or [None])[0]
        print(f"{log_prefix}  [{chat_id[:10]}] turn {u_idx+1} ✓ in={usage.get('input_tokens',0)} out={usage.get('output_tokens',0)} web_qs={len(result.get('web_queries') or [])} preview={new_asst_content[:60]}...")
        sys.stdout.flush()

        # Write back to Firestore
        if not dry_run:
            a_snap.reference.update({
                "content": new_asst_content,
                "contentBeforeRedo": old_asst_content,
            })

        # Update history with the NEW assistant content for next turn
        conversation_history.append(api_msg)
        conversation_history.append({"role": "assistant", "content": new_asst_content})

        stats["asst_msgs_processed"] += 1
        asst_idx += 1

    # Set enableWebSearch on chat doc
    if not dry_run:
        chat_ref.update({"enableWebSearch": True})

    print(f"{log_prefix}[{chat_id[:10]}] DONE — processed={stats['asst_msgs_processed']} errors={stats['errors']} jyutping_leaks={stats['jyutping_leaks']} web_searches={stats['total_searches']}")
    sys.stdout.flush()
    return stats


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--project", default=PROJECT_ID)
    p.add_argument("--chat", help="Single chat ID")
    p.add_argument("--all", action="store_true", help="Process all known starred chats")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--skip-done", action="store_true")
    args = p.parse_args()

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": args.project})
    db = firestore.client()

    if args.chat:
        chat_ids = [args.chat]
    elif args.all:
        chat_ids = TARGET_CHATS
    else:
        print("Specify --chat ID or --all")
        return 2

    print(f"Mode={'DRY' if args.dry_run else 'LIVE'} workers={args.workers} chats={len(chat_ids)} skip_done={args.skip_done}")
    started = time.time()

    if len(chat_ids) == 1 or args.workers <= 1:
        results = [process_chat(db, cid, dry_run=args.dry_run, skip_done=args.skip_done) for cid in chat_ids]
    else:
        results = []
        with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(process_chat, db, cid, args.dry_run, args.skip_done, f"[w{i % args.workers}] "): cid for i, cid in enumerate(chat_ids)}
            for fut in cf.as_completed(futs):
                try:
                    results.append(fut.result())
                except Exception as e:
                    print(f"FATAL for chat {futs[fut]}: {e}")
                    results.append({"chat_id": futs[fut], "errors": 1, "skipped": False})

    elapsed = time.time() - started
    print(f"\n=== SUMMARY ({elapsed:.1f}s) ===")
    for r in results:
        if r.get("skipped"):
            print(f"  [{r['chat_id'][:10]}] SKIPPED: {r.get('reason','?')}")
        else:
            print(f"  [{r['chat_id'][:10]}] {r.get('title','?')[:40]}: processed={r.get('asst_msgs_processed',0)} errors={r.get('errors',0)} jyut={r.get('jyutping_leaks',0)} web={r.get('total_searches',0)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
