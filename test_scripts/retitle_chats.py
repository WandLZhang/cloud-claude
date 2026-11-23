#!/usr/bin/env python3
"""
One-time AI titles for chats that still carry an automatic title (the first 40 characters of their
first message, "Image Chat" or "New Chat"), made by the chat function's own title model and prompt
(make_title in functions/chat/main.py). New chats get theirs from the chat function itself.

  functions/chat/.venv/bin/python test_scripts/retitle_chats.py --owners           # users and chat counts
  functions/chat/.venv/bin/python test_scripts/retitle_chats.py --uid UID          # plan: print old -> new, save it
  functions/chat/.venv/bin/python test_scripts/retitle_chats.py --uid UID --write  # write the saved plan

Skips starred chats, chats renamed by hand (a title that isn't automatic, or titleSource 'manual') and
chats already titled. Each write re-checks in a transaction that the title is still the one the plan
replaces. The plan keeps every old title, in test_scripts/backups/ (git-ignored), for undo.
"""

import argparse
import glob
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ID = "wz-cloud-claude"
BACKUP_DIR = os.path.join(HERE, "backups")
os.environ.setdefault("GOOGLE_CLOUD_QUOTA_PROJECT", PROJECT_ID)

import firebase_admin  # noqa: E402
from firebase_admin import auth, firestore  # noqa: E402

firebase_admin.initialize_app(options={"projectId": PROJECT_ID})
sys.path.insert(0, os.path.join(HERE, "..", "functions", "chat"))
import main as chat_function  # noqa: E402  (its title model, prompt and guarded write)

db = firestore.client()


def js_length(s):
    """JavaScript's String.length: UTF-16 code units."""
    return len(s.encode("utf-16-le")) // 2


def js_first_40(s):
    """JavaScript's String.substring(0, 40)."""
    return s.encode("utf-16-le")[:80].decode("utf-16-le", errors="ignore")


def cut_40(clean):
    return js_first_40(clean) + "..." if js_length(clean) > 40 else clean


def title_until_2026_11_22(content):
    """useChat before 2026-11-22: content.trim().replace(/\\n+/g, ' '), cut to 40 characters."""
    out, after_newline = [], False
    for ch in content.strip():
        if ch == "\n":
            if not after_newline:
                out.append(" ")
            after_newline = True
        else:
            out.append(ch)
            after_newline = False
    return cut_40("".join(out))


def title_since_2026_11_22(content):
    """chatTitle() in src/components/Chat/format.js: lines trimmed, blank lines dropped, joined."""
    return cut_40(" ".join(line.strip() for line in content.split("\n") if line.strip()))


def automatic_titles(content):
    """Every title the app could have made from this first message."""
    titles = {"New Chat", "Image Chat"}
    if content and content.strip():
        titles |= {title_until_2026_11_22(content), title_since_2026_11_22(content)}
    return titles


def chat_start(chat_ref):
    """The chat's opening: its first messages in order, up to the TITLE_TURNS-th user message."""
    msgs = [m.to_dict() for m in chat_ref.collection("messages").order_by("timestamp").limit(16).stream()]
    start, users = [], 0
    for m in msgs:
        if m.get("role") == "user":
            users += 1
            if users > chat_function.TITLE_TURNS:
                break
        start.append(m)
    return start


def first_photo(start):
    """The first photo among the opening user messages, as {data, media_type}, or None."""
    for m in start:
        url = (m.get("image") or {}).get("url") if m.get("role") == "user" else None
        if url and url.startswith("http"):
            b64, mime = chat_function.download_file_from_storage(url)
            return {"data": b64, "media_type": mime}
    return None


def list_owners():
    for user_ref in db.collection("chats").list_documents():
        count = sum(1 for _ in user_ref.collection("conversations").list_documents())
        try:
            u = auth.get_user(user_ref.id)
            who = f"{u.display_name or ''} <{u.email or ''}>"
        except auth.UserNotFoundError:
            who = "(no auth user)"
        print(f"{user_ref.id}  {count:4d} chats  {who}")


def plan(uid, workers):
    convs = list(db.collection("chats").document(uid).collection("conversations").stream())
    skipped = {"starred": [], "renamed": [], "already titled": [], "no first message": []}
    titles = {}
    targets = []
    for c in convs:
        d = c.to_dict()
        titles[c.id] = d.get("title") or ""
        source = d.get("titleSource")
        if source in ("ai", "manual"):
            skipped["already titled" if source == "ai" else "renamed"].append(c.id)
            continue
        if d.get("isStarred"):
            skipped["starred"].append(c.id)
            continue
        start = chat_start(c.reference)
        user = next((m for m in start if m.get("role") == "user"), None)
        if user is None:
            skipped["no first message"].append(c.id)
            continue
        title = d.get("title") or ""
        if source != "auto" and title not in automatic_titles(user.get("content") or ""):
            # The message that made an automatic title may have been edited or deleted since, or sit
            # later: an exact match with any user message still marks the title automatic.
            later = [m.to_dict().get("content") or "" for m in c.reference.collection("messages").order_by("timestamp").stream()
                     if m.to_dict().get("role") == "user"]
            if not any(title in automatic_titles(text) for text in later if text.strip()):
                skipped["renamed"].append(c.id)
                continue
        targets.append({"chatId": c.id, "oldTitle": title, "titleSourceBefore": source, "start": start})
    print(f"{len(convs)} chats: {len(targets)} to title; skipped "
          + ", ".join(f"{len(v)} {k}" for k, v in skipped.items()))
    for reason, ids in skipped.items():
        for cid in ids:
            print(f"  skip ({reason}) {cid}  {titles[cid]!r}")

    def title_one(t):
        start = t.pop("start")
        users = [m.get("content") or "" for m in start if m.get("role") == "user"]
        replies = [m.get("content") or "" for m in start if m.get("role") == "assistant"]
        try:
            t["newTitle"] = chat_function.make_title(chat_function.title_blocks(users, replies, first_photo(start))) or ""
            if not t["newTitle"]:
                t["note"] = "no usable title (SKIP or a sentence): keeps its automatic title"
        except Exception as e:  # noqa: BLE001
            t["newTitle"], t["error"] = "", f"{chat_function.TITLE_MODEL}: {chat_function.error_text(e)}"
        return t

    with ThreadPoolExecutor(max_workers=workers) as pool:
        done = list(pool.map(title_one, targets))
    for t in done:
        print(f"{t['chatId']}  {t['oldTitle']!r}  ->  {t['newTitle']!r}" + (f"  ERROR {t['error']}" if t.get("error") else "")
              + (f"  ({t['note']})" if t.get("note") else ""))
    os.makedirs(BACKUP_DIR, exist_ok=True)
    path = os.path.join(BACKUP_DIR, f"retitle-plan-{uid}-{time.strftime('%Y%m%d-%H%M%S')}.json")
    with open(path, "w") as f:
        json.dump([{k: t.get(k) for k in ("chatId", "oldTitle", "newTitle", "titleSourceBefore", "error", "note")} for t in done],
                  f, ensure_ascii=False, indent=1)
    print(f"plan saved to {path}: {sum(1 for t in done if t['newTitle'])} titles, {sum(1 for t in done if t.get('error'))} errors")


def write(uid, path):
    if not path:
        plans = sorted(glob.glob(os.path.join(BACKUP_DIR, f"retitle-plan-{uid}-*.json")))
        if not plans:
            sys.exit(f"no plan for {uid} in {BACKUP_DIR}; run without --write first")
        path = plans[-1]
    items = json.load(open(path))
    written, kept = 0, []
    for t in items:
        if not t.get("newTitle"):
            continue
        ref = db.collection("chats").document(uid).collection("conversations").document(t["chatId"])
        expected = None if t["titleSourceBefore"] == "auto" else t["oldTitle"]
        if chat_function.save_title(ref, t["newTitle"], expected_title=expected):
            written += 1
        else:
            kept.append(t["chatId"])
    print(f"from {path}: wrote {written} titles; {len(kept)} chats changed since the plan and kept their title: {kept}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--owners", action="store_true", help="list users and their chat counts")
    ap.add_argument("--uid", help="whose chats to title")
    ap.add_argument("--write", action="store_true", help="write the saved plan (default: make a plan)")
    ap.add_argument("--plan", help="the plan file to write (default: the newest for --uid)")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    if args.owners:
        list_owners()
    elif args.uid and args.write:
        write(args.uid, args.plan)
    elif args.uid:
        plan(args.uid, args.workers)
    else:
        ap.error("pass --owners or --uid")
