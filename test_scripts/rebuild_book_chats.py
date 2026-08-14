"""Rebuild the starred book-translation chats FROM THE PAGE PHOTOS.

Replaces redo_starred_chats.py and redo_starred_translations.py. Both of those paired
`user_msgs[i]` with `asst_msgs[i]` by list position, which has no defence against a missing or
surplus message — in 灰姑娘 it wrote a second copy of page 4 over page 3, and page 3's translation
stopped existing. This script never pairs by position.

WHY REBUILD RATHER THAN PATCH
  The page photos are the only uncorrupted record in these chats. Message ORDER is not trustworthy:
  before cloud-claude commit f0eb3d4 the final update overwrote each assistant message's timestamp
  with its COMPLETION time, so a reply that took longer than the gap to the next photo sorts after
  that photo. Audited live: 13 photos with no reply under them, 7 replies with no photo above, and
  553 user messages against 547 assistant messages.

WHAT IT DOES, PER CHAT
  1. Back up the chat doc + every message to backups/<ts>/<chatId>.json. Nothing is written until
     that file exists.
  2. Take the user messages that carry an image, in timestamp order. That ordinal is the page number.
  3. Translate each page in ONE stateless call — the page image plus an explicit per-page
     instruction. The old path sent an empty user message on image turns, so the only instruction in
     a 70-page chat was the first turn's one-liner.
  4. Write the result onto an assistant doc that is bound to its page with `replyTo`, timestamped
     1 ms after its photo, with the previous text kept in `contentBeforeRebuild`.
  5. Leave the conversation turns between pages alone (corrections and questions you typed), just
     anchored. Flag — do NOT delete — any assistant doc with no page to answer: in 木偶奇遇记 that
     doc holds a real page translation whose photo was never saved. --delete-surplus is opt-in.
  6. Verify: every photo has exactly one reply. Refuse to finish otherwise.

Usage:
    source .venv/bin/activate
    python test_scripts/rebuild_book_chats.py --chat QjYqcD7epRfGcIs96t40            # dry run
    python test_scripts/rebuild_book_chats.py --chat QjYqcD7epRfGcIs96t40 --apply
    python test_scripts/rebuild_book_chats.py --all --apply --workers 3
"""

import argparse
import base64
import concurrent.futures as cf
import datetime
import json
import pathlib
import sys
import threading
import time
import urllib.request

import firebase_admin
from firebase_admin import firestore

HERE = pathlib.Path(__file__).parent
PROJECT_ID = "wz-cloud-claude"
USER_ID = "xoBY9nLz8ObwvIRPdJ855EBmAlv2"

# Winner of tasks/book-page-translation in WandLZhang/language-benchmarks. Override with --model.
DEFAULT_MODEL = "claude-opus-5"
MAX_RETRIES = 3

# Each model's ceiling, probed against Vertex. Nothing here is latency-sensitive, and adaptive
# thinking spends from the SAME budget as the answer — at 8000, claude-sonnet-5 came back with
# stop_reason='max_tokens', 8000 tokens of thinking and ZERO text on 11 of 24 benchmark pages.
MAX_TOKENS = {"anthropic": 128000, "gemini": 65536}

# Provider registry. The benchmark field is vision-capable Claude + Gemini; MaaS models on Vertex
# take text only and cannot read a page photo.
MODELS = {
    "claude-opus-5":         ("anthropic", "claude-opus-5"),
    "claude-opus-4-8":       ("anthropic", "claude-opus-4-8"),
    "claude-opus-4-7":       ("anthropic", "claude-opus-4-7"),
    "claude-sonnet-5":       ("anthropic", "claude-sonnet-5"),
    "gemini-3.5-flash":      ("gemini",    "gemini-3.5-flash"),
    "gemini-3.6-flash":      ("gemini",    "gemini-3.6-flash"),
    "gemini-3.5-flash-lite": ("gemini",    "gemini-3.5-flash-lite"),
}

# Saved prompt templates (prompts/<uid>/userPrompts/<id>) — the same ones the app sends.
TEMPLATE_ZH_TO_YUE = "g8QTqrl3O40ex8pmBSvf"   # 中 → 粵
TEMPLATE_EN_TO_PU_YUE = "K731ZzMJXnlP85BNCFmY"  # EN → 普粵 (books)

PAGE_INSTRUCTION = ("The text is printed on the attached photo of a single page of a children's "
                    "book. Translate ONLY the text printed on THIS page — do not continue the "
                    "story, do not summarise, do not skip a line.")

# How many previous pages of this book to carry as context. The benchmark's `history` arm beat
# `stateless` for the strong models once this instruction was restated on every turn — claude-opus-5
# colloquial 4.49 -> 4.69, vividness 3.99 -> 4.12 — because story context keeps character names and
# register consistent. It was measured over runs of at most 5 prior pages, so the window stays in
# that regime instead of dragging 70 photos into a 71-page book's last call.
HISTORY_PAGES = 4

_lock = threading.Lock()
_clients = {}


def _anthropic():
    with _lock:
        if "ant" not in _clients:
            from anthropic import AnthropicVertex
            _clients["ant"] = AnthropicVertex(region="global", project_id=PROJECT_ID)
        return _clients["ant"]


def _gemini():
    with _lock:
        if "gem" not in _clients:
            from google import genai
            _clients["gem"] = genai.Client(vertexai=True, project=PROJECT_ID, location="global")
        return _clients["gem"]


def translate_page(model_id, system, instruction, image_bytes, mime="image/jpeg", history=()):
    """Translate one page. `history` = [(image_bytes, mime, instruction, previous_output)] for the
    preceding pages, newest last. Returns the translation text; raises after MAX_RETRIES."""
    provider, vertex_id = MODELS[model_id]

    def ant_blocks():
        msgs = []
        for h_img, h_mime, h_instr, h_out in history:
            msgs.append({"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": h_mime,
                                             "data": base64.b64encode(h_img).decode()}},
                {"type": "text", "text": h_instr}]})
            msgs.append({"role": "assistant", "content": [{"type": "text", "text": h_out}]})
        msgs.append({"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": mime,
                                         "data": base64.b64encode(image_bytes).decode()}},
            {"type": "text", "text": instruction}]})
        return msgs

    last = None
    for attempt in range(MAX_RETRIES):
        try:
            if provider == "anthropic":
                # Streaming is mandatory at this budget — the SDK refuses a non-streaming call
                # whose max_tokens could take over 10 minutes.
                with _anthropic().messages.stream(
                        model=vertex_id, max_tokens=MAX_TOKENS["anthropic"],
                        system=[{"type": "text", "text": system}],
                        thinking={"type": "adaptive"},
                        output_config={"effort": "max"},
                        messages=ant_blocks()) as st:
                    for _ in st:
                        pass
                    msg = st.get_final_message()
                text = "".join(b.text for b in msg.content
                               if getattr(b, "type", None) == "text").strip()
                if not text and getattr(msg, "stop_reason", None) == "max_tokens":
                    raise RuntimeError(f"{model_id} hit max_tokens with no text "
                                       f"({msg.usage.output_tokens} tokens of thinking)")
                return text
            from google.genai import types
            contents = []
            for h_img, h_mime, h_instr, h_out in history:
                contents.append(types.Content(role="user", parts=[
                    types.Part.from_bytes(data=h_img, mime_type=h_mime),
                    types.Part.from_text(text=h_instr)]))
                contents.append(types.Content(role="model",
                                              parts=[types.Part.from_text(text=h_out)]))
            contents.append(types.Content(role="user", parts=[
                types.Part.from_bytes(data=image_bytes, mime_type=mime),
                types.Part.from_text(text=instruction)]))
            r = _gemini().models.generate_content(
                model=vertex_id, contents=contents,
                config=types.GenerateContentConfig(system_instruction=system,
                                                   max_output_tokens=MAX_TOKENS["gemini"]))
            return (r.text or "").strip()
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt * 2)
    raise last


def detect_template(chat_doc, first_user_content):
    """EN books vs Chinese books, from the chat's own stored system prompt."""
    sp = chat_doc.get("systemPrompt") or ""
    if sp.startswith("You translate English text into both"):
        return TEMPLATE_EN_TO_PU_YUE
    if sp.startswith("You translate Mandarin Chinese text into"):
        return TEMPLATE_ZH_TO_YUE
    if "in English you will translate" in first_user_content:
        return TEMPLATE_EN_TO_PU_YUE
    return TEMPLATE_ZH_TO_YUE


def fetch_image(url, cache):
    with _lock:
        hit = cache.get(url)
    if hit is None:
        hit = urllib.request.urlopen(url, timeout=120).read()
        with _lock:
            cache[url] = hit
    return hit


def backup_chat(chat_ref, chat_doc, msgs, backup_dir):
    """Full JSON dump before anything is touched. Written even in dry-run."""
    def enc(v):
        if isinstance(v, datetime.datetime):
            return v.isoformat()
        if isinstance(v, dict):
            return {k: enc(x) for k, x in v.items()}
        if isinstance(v, list):
            return [enc(x) for x in v]
        return v

    backup_dir.mkdir(parents=True, exist_ok=True)
    path = backup_dir / f"{chat_ref.id}.json"
    path.write_text(json.dumps({
        "chat_id": chat_ref.id,
        "chat": enc(chat_doc),
        "messages": [{"id": s.id, **enc(d)} for s, d in msgs],
    }, ensure_ascii=False, indent=2))
    return path


def plan_pages(msgs):
    """Bind every user turn to the assistant doc that answers it.

    Greedy over the timestamp-ordered list: each user message claims the next assistant doc that
    appears after it and is still unclaimed. Reusing existing doc ids keeps message history and any
    deep-links alive, without ever assuming the two lists line up by position.

    TEXT-ONLY user turns are anchored too, not just page photos. These chats contain real
    conversation between the pages — corrections ("improve cadence to be symmetrical and natural")
    and questions ("How do I say vain because the queen was vain") — and their replies must not be
    mistaken for surplus and deleted. They are anchored and otherwise left exactly as they are.

    Returns (pages, text_turns, surplus):
      pages      [(page_no, user_snap, user_data, assistant_snap_or_None)]  -> regenerated
      text_turns [(user_snap, assistant_snap_or_None)]                      -> replyTo only
      surplus    [assistant_snap]                                           -> nothing answers to
    """
    assistant_idx = [i for i, (_, d) in enumerate(msgs) if d.get("role") == "assistant"]
    claimed = set()
    pages, text_turns = [], []
    page = 0

    for i, (snap, d) in enumerate(msgs):
        if d.get("role") != "user":
            continue
        target = next((j for j in assistant_idx if j > i and j not in claimed), None)
        if target is not None:
            claimed.add(target)
        reply = msgs[target][0] if target is not None else None
        if d.get("image"):
            page += 1
            pages.append((page, snap, d, reply))
        else:
            text_turns.append((snap, reply))

    surplus = [msgs[j][0] for j in assistant_idx if j not in claimed]
    return pages, text_turns, surplus


def process_chat(db, chat_id, templates, model_id, backup_dir, apply, img_cache,
                 delete_surplus=False, history_pages=HISTORY_PAGES, log=print):
    chat_ref = db.collection("chats").document(USER_ID).collection("conversations").document(chat_id)
    chat_doc = chat_ref.get().to_dict() or {}
    title = chat_doc.get("title", "(untitled)")
    msgs = [(s, s.to_dict() or {}) for s in chat_ref.collection("messages").order_by("timestamp").stream()]
    if not msgs:
        return {"chat_id": chat_id, "title": title, "skipped": "no messages"}

    first_user = next((d.get("content", "") for _, d in msgs if d.get("role") == "user"), "")
    tid = detect_template(chat_doc, first_user)
    tpl = templates[tid]
    system, instruction = tpl["systemPrompt"], f"{tpl['content']}\n\n{PAGE_INSTRUCTION}"

    backup_path = backup_chat(chat_ref, chat_doc, msgs, backup_dir)
    pages, text_turns, surplus = plan_pages(msgs)
    if not pages:
        return {"chat_id": chat_id, "title": title, "skipped": "no page photos"}

    log(f"[{chat_id[:10]}] '{title}' — {len(pages)} pages, {len(text_turns)} text turn(s) kept, "
        f"{len(surplus)} surplus reply doc(s), template={tid[:8]}, backup={backup_path.name}")

    stats = {"chat_id": chat_id, "title": title, "skipped": None, "pages": len(pages),
             "rebuilt": 0, "created": 0, "deleted": 0, "errors": 0,
             "text_turns": len(text_turns), "corrected_pages": [], "surplus": []}

    # Anchor the conversation turns without touching their text. A text turn between two pages is
    # usually the user correcting the page above it, so flag the page before it for a read-through.
    page_before = {}
    running = 0
    for _, u_snap, _, _ in pages:
        running += 1
        page_before[u_snap.id] = running
    order = {s.id: i for i, (s, _) in enumerate(msgs)}
    for u_snap, a_snap in text_turns:
        prior = [p for p, s, _, _ in pages if order[s.id] < order[u_snap.id]]
        if prior:
            stats["corrected_pages"].append(prior[-1])
        if a_snap is not None:
            log(f"  [{chat_id[:10]}] keeping conversation turn {u_snap.id} -> {a_snap.id} "
                f"(anchored, text unchanged)")
            if apply:
                a_snap.reference.update({"replyTo": u_snap.id})

    history = []
    for page, u_snap, u_data, a_snap in pages:
        try:
            img = fetch_image(u_data["image"]["url"], img_cache)
            mime = u_data["image"].get("type", "image/jpeg")
            text = translate_page(model_id, system, instruction, img, mime,
                                  history=tuple(history[-history_pages:]) if history_pages else ())
        except Exception as e:  # noqa: BLE001
            log(f"  [{chat_id[:10]}] p{page:3d} ERROR {type(e).__name__}: {str(e)[:90]}")
            stats["errors"] += 1
            continue
        if not text:
            log(f"  [{chat_id[:10]}] p{page:3d} EMPTY response — leaving the old text in place")
            stats["errors"] += 1
            continue

        # Full payload log: what went in (system + instruction + which photo) and what came out.
        log(f"  [{chat_id[:10]}] p{page:3d} sys={len(system)}ch img={len(img)}B "
            f"hist={len(history[-history_pages:]) if history_pages else 0}p "
            f"msg={u_snap.id} -> {len(text)}ch  {text[:70]}".replace("\n", " "))
        history.append((img, mime, instruction, text))

        payload = {
            "role": "assistant",
            "content": text,
            "replyTo": u_snap.id,
            "pageIndex": page,
            "model": model_id,
            "rebuiltAt": firestore.SERVER_TIMESTAMP,
            "isStreaming": False,
            "userId": USER_ID,
            # 1 ms after the photo: the reply sorts under its own page even for clients that still
            # order purely by timestamp.
            "timestamp": u_data["timestamp"] + datetime.timedelta(milliseconds=1),
        }
        if a_snap is not None:
            prev_doc = a_snap.to_dict() or {}
            # Keep the text as it was BEFORE the first rebuild. Re-running must not overwrite that
            # with the previous rebuild's output and quietly lose the original.
            if "contentBeforeRebuild" not in prev_doc:
                payload["contentBeforeRebuild"] = prev_doc.get("content", "")
            if apply:
                a_snap.reference.update(payload)
            stats["rebuilt"] += 1
        else:
            if apply:
                chat_ref.collection("messages").add(payload)
            stats["created"] += 1

    # Surplus = an assistant doc with no page to answer. In 木偶奇遇记 that doc holds a REAL page
    # translation whose photo was never saved, so deleting it would destroy content that cannot be
    # regenerated. Flag it instead and print it; --delete-surplus is opt-in once you have looked.
    for s in surplus:
        preview = ((s.to_dict() or {}).get("content") or "")[:90].replace("\n", " ")
        stats["surplus"].append({"id": s.id, "preview": preview})
        if delete_surplus:
            log(f"  [{chat_id[:10]}] DELETING surplus reply {s.id} (kept in backup): {preview}")
            if apply:
                s.reference.delete()
            stats["deleted"] += 1
        else:
            log(f"  [{chat_id[:10]}] surplus reply {s.id} has no page to answer — flagged, NOT "
                f"deleted: {preview}")
            if apply:
                s.reference.update({"orphaned": True})

    if apply:
        chat_ref.update({"systemPrompt": system, "enableWebSearch": bool(tpl.get("enableWebSearch")),
                         "rebuiltAt": firestore.SERVER_TIMESTAMP, "rebuiltModel": model_id})
        stats["verify"] = verify_chat(chat_ref)
        log(f"[{chat_id[:10]}] verify: {stats['verify']}")

    log(f"[{chat_id[:10]}] DONE rebuilt={stats['rebuilt']} created={stats['created']} "
        f"deleted={stats['deleted']} errors={stats['errors']}")
    if stats["corrected_pages"]:
        log(f"[{chat_id[:10]}] pages followed by a conversation turn (usually a correction you "
            f"asked for — the fresh translation will not know about it): {stats['corrected_pages']}")
    return stats


def verify_chat(chat_ref):
    """Every photo answered exactly once, no assistant doc left unanchored."""
    msgs = [(s.id, s.to_dict() or {}) for s in chat_ref.collection("messages").order_by("timestamp").stream()]
    photos = {mid for mid, d in msgs if d.get("role") == "user" and d.get("image")}
    replies = {}
    unanchored = []
    for mid, d in msgs:
        if d.get("role") != "assistant":
            continue
        parent = d.get("replyTo")
        if parent in photos:
            replies.setdefault(parent, []).append(mid)
        else:
            unanchored.append(mid)
    unanswered = sorted(photos - set(replies))
    doubled = sorted(p for p, r in replies.items() if len(r) > 1)
    # One unanchored reply is expected: the answer to the leading text-only instruction turn.
    return {"pages": len(photos), "unanswered": unanswered, "doubled": doubled,
            "unanchored": len(unanchored), "ok": not unanswered and not doubled}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=PROJECT_ID)
    ap.add_argument("--chat", help="single chat id")
    ap.add_argument("--all", action="store_true", help="every starred chat that has page photos")
    ap.add_argument("--model", default=DEFAULT_MODEL, choices=sorted(MODELS))
    ap.add_argument("--workers", type=int, default=3, help="chats in parallel")
    ap.add_argument("--apply", action="store_true", help="write to Firestore (default: dry run)")
    ap.add_argument("--history-pages", type=int, default=HISTORY_PAGES,
                    help="previous pages carried as context (0 = stateless)")
    ap.add_argument("--delete-surplus", action="store_true",
                    help="delete assistant docs with no page to answer instead of flagging them")
    args = ap.parse_args()

    if not args.chat and not args.all:
        print("Specify --chat <id> or --all")
        return 2

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": args.project})
    db = firestore.client()

    templates = {}
    for tid in (TEMPLATE_ZH_TO_YUE, TEMPLATE_EN_TO_PU_YUE):
        d = db.collection("prompts").document(USER_ID).collection("userPrompts").document(tid).get().to_dict()
        if not d or not d.get("systemPrompt"):
            print(f"FATAL: prompt template {tid} missing or has no systemPrompt")
            return 1
        templates[tid] = d
        print(f"template {tid[:8]} '{d.get('title')}' — {len(d['systemPrompt'])} chars")

    if args.chat:
        chat_ids = [args.chat]
    else:
        chat_ids = [s.id for s in db.collection("chats").document(USER_ID)
                    .collection("conversations").where("isStarred", "==", True).stream()]

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = HERE / "backups" / ts
    mode = "APPLY" if args.apply else "DRY RUN"
    print(f"\n{mode} · model={args.model} · {len(chat_ids)} chat(s) · workers={args.workers} · "
          f"backups -> {backup_dir}\n")

    img_cache = {}
    buffers = {}

    def run(cid):
        lines = []
        try:
            r = process_chat(db, cid, templates, args.model, backup_dir, args.apply,
                             img_cache, args.delete_surplus, args.history_pages,
                             log=lines.append)
        except Exception as e:  # noqa: BLE001
            lines.append(f"[{cid[:10]}] FATAL {type(e).__name__}: {e}")
            r = {"chat_id": cid, "title": "?", "skipped": None, "errors": 1, "pages": 0,
                 "rebuilt": 0, "created": 0, "deleted": 0, "surplus": []}
        buffers[cid] = lines
        print("\n".join(lines), flush=True)
        return r

    started = time.time()
    if len(chat_ids) == 1 or args.workers <= 1:
        results = [run(c) for c in chat_ids]
    else:
        with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
            results = list(ex.map(run, chat_ids))

    print(f"\n=== SUMMARY ({time.time() - started:.0f}s, {mode}) ===")
    bad = 0
    for r in results:
        if r.get("skipped"):
            print(f"  [{r['chat_id'][:10]}] SKIPPED: {r['skipped']}")
            continue
        v = r.get("verify")
        flag = "" if (v is None or v["ok"]) else "  <-- VERIFY FAILED"
        if flag:
            bad += 1
        print(f"  [{r['chat_id'][:10]}] {str(r.get('title'))[:34]:34} pages={r['pages']:3d} "
              f"rebuilt={r['rebuilt']:3d} created={r['created']:2d} deleted={r['deleted']:2d} "
              f"errors={r['errors']:2d}{flag}")
        if flag:
            print(f"      {v}")
    if not args.apply:
        print("\nDry run — nothing was written. Backups were still taken; re-run with --apply.")
    if bad:
        print(f"\n{bad} chat(s) failed verification. Restore from {backup_dir} before retrying.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
