"""Rebuild book chats from the page photos — command line front end.

All the logic lives in functions/book_qa/pipeline.py so the nightly job and this script run the
same code. This file is only argument parsing and console output.

Usage:
    source .venv/bin/activate
    python test_scripts/rebuild_book_chats.py --chat QjYqcD7epRfGcIs96t40            # dry run
    python test_scripts/rebuild_book_chats.py --chat QjYqcD7epRfGcIs96t40 --apply
    python test_scripts/rebuild_book_chats.py --all --apply --workers 3
"""
import argparse
import concurrent.futures as cf
import datetime
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "functions" / "book_qa"))
import pipeline  # noqa: E402

import firebase_admin  # noqa: E402
from firebase_admin import firestore  # noqa: E402

HERE = pathlib.Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=pipeline.PROJECT_ID)
    ap.add_argument("--chat", help="single chat id")
    ap.add_argument("--all", action="store_true", help="every starred chat that has page photos")
    ap.add_argument("--model", default=pipeline.DEFAULT_MODEL, choices=sorted(pipeline.MODELS))
    ap.add_argument("--workers", type=int, default=3, help="chats in parallel")
    ap.add_argument("--apply", action="store_true", help="write to Firestore (default: dry run)")
    ap.add_argument("--history-pages", type=int, default=pipeline.HISTORY_PAGES,
                    help="previous pages carried as context (0 = stateless)")
    ap.add_argument("--strip-asides", action="store_true",
                    help="delete typed turns + their replies, leaving only photo -> translation")
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
    for tid in (pipeline.TEMPLATE_ZH_TO_YUE, pipeline.TEMPLATE_EN_TO_PU_YUE):
        d = db.collection("prompts").document(pipeline.USER_ID).collection("userPrompts").document(tid).get().to_dict()
        if not d or not d.get("systemPrompt"):
            print(f"FATAL: prompt template {tid} missing or has no systemPrompt")
            return 1
        templates[tid] = d
        print(f"template {tid[:8]} '{d.get('title')}' — {len(d['systemPrompt'])} chars")

    if args.chat:
        chat_ids = [args.chat]
    else:
        chat_ids = [s.id for s in db.collection("chats").document(pipeline.USER_ID)
                    .collection("conversations").where("isStarred", "==", True).stream()]

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = HERE / "backups" / ts
    mode = "APPLY" if args.apply else "DRY RUN"
    print(f"\n{mode} · model={args.model} · {len(chat_ids)} chat(s) · workers={args.workers} · "
          f"backups -> {backup_dir}\n")

    if args.strip_asides:
        tot_p = tot_d = 0
        for cid in chat_ids:
            r = pipeline.strip_asides(db, cid, backup_dir, args.apply, log=print)
            if r.get("skipped"):
                continue
            print(f"[{cid[:10]}] {r['title'][:32]:32} photos={r['photos']:3d} deleted={r['deleted']}")
            tot_p += r["photos"]; tot_d += r["deleted"]
        print(f"\n{'APPLIED' if args.apply else 'DRY RUN'}: {tot_d} message(s) removed, "
              f"{tot_p} photos intact. Backups in {backup_dir}")
        return 0

    img_cache = {}
    buffers = {}

    def run(cid):
        lines = []
        try:
            r = pipeline.process_chat(db, cid, templates, args.model, backup_dir, args.apply,
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
        if r.get("drift"):
            flag += f"  <-- {len(r['drift'])} DRIFT"
        if v is not None and not v["ok"]:
            bad += 1
        print(f"  [{r['chat_id'][:10]}] {str(r.get('title'))[:34]:34} pages={r['pages']:3d} "
              f"rebuilt={r['rebuilt']:3d} created={r['created']:2d} deleted={r['deleted']:2d} "
              f"sheet={r.get('sheet_terms',0)}t/{r.get('sheet_refrains',0)}r "
              f"errors={r['errors']:2d}{flag}")
        for d in (r.get("drift") or [])[:4]:
            print(f"      drift: {d['source'][:40]!r} -> {d['yue'][:30]!r} missing on {d['missing_on']}")
        if v is not None and not v["ok"]:
            print(f"      {v}")
    if not args.apply:
        print("\nDry run — nothing was written. Backups were still taken; re-run with --apply.")
    if bad:
        print(f"\n{bad} chat(s) failed verification. Restore from {backup_dir} before retrying.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
