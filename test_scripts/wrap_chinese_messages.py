"""Backfill: wrap Chinese characters in past assistant messages with the
HTML markup needed for the Visual Fonts (canto.hk) jyutping rendering and
inline <ruby> tags for Mandarin pinyin.

Idempotent: each processed message gets `contentOriginal` set to the raw
content. Re-runs skip messages that already have `contentOriginal`.

Driven by Claude (Opus 4.7 by default) on Anthropic Vertex AI — same
channel as the chat function. Uses the shared prompt from
`functions/chat/wrap_prompt.py`.

Usage:
    source .venv/bin/activate
    python test_scripts/wrap_chinese_messages.py --project wz-cloud-claude

Common flags:
    --dry-run             Walk + Claude-call but do NOT write Firestore.
                          Prints first 500 chars of original/wrapped diff.
    --user UID            Restrict to a single user.
    --chat CHATID         Restrict to a single conversation. Strongly
                          recommended for the first verification run.
    --limit N             Cap total messages processed.
    --workers N           Parallel Claude calls (default 8).
    --fast                Use Sonnet 4.6 instead of Opus 4.7 (cheaper, faster,
                          slightly less accurate).

Re-running is safe: docs that already have `contentOriginal` are skipped.
"""

import argparse
import concurrent.futures as cf
import pathlib
import sys
import time

import json
import urllib.request

import firebase_admin
from firebase_admin import firestore

PROJECT_ID = "wz-cloud-claude"
CLOUD_FUNCTION_URL = "https://us-east4-wz-cloud-claude.cloudfunctions.net/chat"

BATCH_SIZE = 500
CJK_RANGE = range(0x4E00, 0xA000)


def has_cjk(text: str) -> bool:
    for ch in text:
        if ord(ch) in CJK_RANGE:
            return True
    return False


def wrap_one(content: str, use_fast: bool = True) -> str:
    """POST to the chat Cloud Function's wrap_content mode. Returns wrapped text."""
    payload = json.dumps({"wrap_content": content, "use_fast_model": use_fast}).encode()
    req = urllib.request.Request(
        CLOUD_FUNCTION_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    return data.get("wrapped", content)


def collect_targets(db, only_user, only_chat, force=False):
    """Walk the Firestore tree and return list of (msg_ref, content) for
    every assistant message that needs processing (has CJK, no contentOriginal).
    With force=True, re-process messages even if contentOriginal is already set
    (uses contentOriginal as the source instead of content)."""
    chats_root = db.collection("chats")
    user_docs = list(chats_root.list_documents())
    if only_user:
        user_docs = [d for d in user_docs if d.id == only_user]

    targets = []
    chat_count = 0
    msg_seen = 0

    for user_doc in user_docs:
        for conv_doc in user_doc.collection("conversations").list_documents():
            if only_chat and conv_doc.id != only_chat:
                continue
            chat_count += 1
            for msg in conv_doc.collection("messages").stream():
                msg_seen += 1
                d = msg.to_dict() or {}
                if d.get("role") != "assistant":
                    continue
                if "contentOriginal" in d:
                    if not force:
                        continue  # already processed
                    source = d.get("contentOriginal") or ""
                else:
                    source = d.get("content") or ""
                if not source.strip():
                    continue
                if not has_cjk(source):
                    continue
                targets.append((msg.reference, source))

    return targets, chat_count, msg_seen


def backfill(args) -> int:
    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": args.project})
    db = firestore.client()

    print(
        f"Mode={'DRY RUN' if args.dry_run else 'LIVE'}  "
        f"project={args.project}  user={args.user or 'ALL'}  "
        f"chat={args.chat or 'ALL'}  workers={args.workers}  "
        f"model={'fast (Sonnet 4.6)' if args.fast else 'default (Opus 4.7)'}"
    )

    targets, chat_count, msg_seen = collect_targets(db, args.user, args.chat, force=args.force)
    print(f"Scanned {chat_count} chat(s) / {msg_seen} message(s) → {len(targets)} need processing")

    if args.limit and len(targets) > args.limit:
        print(f"Capping at --limit {args.limit}")
        targets = targets[: args.limit]

    if not targets:
        print("Nothing to do.")
        return 0

    started = time.time()
    wrapped_count = 0
    noop_count = 0
    error_count = 0
    pending_writes = []  # list of (msg_ref, content_original, content_new)

    def flush(force_dry_print=False):
        nonlocal pending_writes
        if not pending_writes:
            return
        if args.dry_run:
            for ref, orig, new in pending_writes:
                print(f"\n--- DRY {ref.path} ---")
                print(f"ORIG[:500]: {orig[:500]}")
                print(f"NEW [:500]: {new[:500]}")
        else:
            # Batched commits in groups of BATCH_SIZE
            for i in range(0, len(pending_writes), BATCH_SIZE):
                batch = db.batch()
                slab = pending_writes[i : i + BATCH_SIZE]
                for ref, orig, new in slab:
                    batch.update(ref, {"contentOriginal": orig, "content": new})
                batch.commit()
                print(f"  committed batch of {len(slab)} update(s)")
        pending_writes = []

    def process(target):
        ref, content = target
        try:
            wrapped = wrap_one(content, use_fast=args.fast)
            return ref, content, wrapped, None
        except Exception as e:
            return ref, content, None, e

    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(process, t) for t in targets]
        for i, fut in enumerate(cf.as_completed(futs), 1):
            ref, content, wrapped, err = fut.result()
            if err is not None:
                error_count += 1
                print(f"[{i}/{len(targets)}] ERROR {ref.path}: {err}")
                continue
            if wrapped == content:
                noop_count += 1
                # Still mark as processed by setting contentOriginal=content
                # (no content change); avoids re-calling Claude on next run.
                pending_writes.append((ref, content, content))
            else:
                wrapped_count += 1
                pending_writes.append((ref, content, wrapped))
            if i % 50 == 0:
                elapsed = time.time() - started
                rate = i / elapsed if elapsed else 0
                eta = (len(targets) - i) / rate if rate else 0
                print(
                    f"[{i}/{len(targets)}] wrapped={wrapped_count} noop={noop_count} "
                    f"err={error_count} rate={rate:.2f}/s eta={eta:.0f}s"
                )
            if len(pending_writes) >= BATCH_SIZE:
                flush()

    flush()

    elapsed = time.time() - started
    print()
    print("=" * 60)
    print(f"Mode:           {'DRY RUN' if args.dry_run else 'LIVE'}")
    print(f"Project:        {args.project}")
    print(f"Chats scanned:  {chat_count}")
    print(f"Msgs scanned:   {msg_seen}")
    print(f"Targets:        {len(targets)}")
    print(f"Wrapped:        {wrapped_count}")
    print(f"No-op:          {noop_count}")
    print(f"Errors:         {error_count}")
    print(f"Elapsed:        {elapsed:.1f}s")
    print("=" * 60)

    return 0 if error_count == 0 else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="GCP project id")
    parser.add_argument("--dry-run", action="store_true", help="No writes")
    parser.add_argument("--user", default=None, help="Restrict to one uid")
    parser.add_argument("--chat", default=None, help="Restrict to one chat id")
    parser.add_argument("--limit", type=int, default=None, help="Cap total messages")
    parser.add_argument("--workers", type=int, default=8, help="Parallel Claude calls")
    parser.add_argument("--fast", action="store_true", help="Use Sonnet 4.6 not Opus 4.7")
    parser.add_argument("--force", action="store_true", help="Re-process even if contentOriginal already set")
    args = parser.parse_args()
    sys.exit(backfill(args))


if __name__ == "__main__":
    main()
