"""One-time idempotent backfill: add `userId` to every existing message doc.

The new client-side search uses a `collectionGroup('messages')` query scoped
by `where('userId', '==', uid)`. Existing docs predate the field, so they
need to be backfilled or they are invisible to search.

Usage:
    source venv/bin/activate   # or .venv/bin/activate
    python functions/scripts/backfill_message_userid.py --project wz-cloud-claude

Optional flags:
    --dry-run      Walk the tree and report counts; do not write anything.
    --user UID     Restrict backfill to a single user.

Re-running is safe: docs that already have `userId` are skipped.
"""

import argparse
import sys
import time

import firebase_admin
from firebase_admin import credentials, firestore


BATCH_SIZE = 500  # Firestore hard limit per WriteBatch


def backfill(project_id: str, dry_run: bool, only_user: str | None) -> int:
    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": project_id})
    db = firestore.client()

    chats_root = db.collection("chats")
    user_docs = list(chats_root.list_documents())
    if only_user:
        user_docs = [d for d in user_docs if d.id == only_user]

    print(f"Scanning {len(user_docs)} user(s) under chats/...")

    total_chats = 0
    total_messages = 0
    total_updated = 0
    total_skipped = 0

    started_at = time.time()
    batch = db.batch()
    batch_count = 0

    def flush():
        nonlocal batch, batch_count
        if batch_count == 0:
            return
        if not dry_run:
            batch.commit()
        print(f"  committed batch of {batch_count} update(s)")
        batch = db.batch()
        batch_count = 0

    for user_doc in user_docs:
        uid = user_doc.id
        conversations = user_doc.collection("conversations").list_documents()
        for conv_doc in conversations:
            total_chats += 1
            messages = conv_doc.collection("messages").stream()
            for msg in messages:
                total_messages += 1
                data = msg.to_dict() or {}
                if data.get("userId") == uid:
                    total_skipped += 1
                    continue
                batch.update(msg.reference, {"userId": uid})
                batch_count += 1
                total_updated += 1
                if batch_count >= BATCH_SIZE:
                    flush()
        print(
            f"user={uid}: scanned {total_messages} messages, "
            f"updated {total_updated}, skipped {total_skipped}"
        )

    flush()

    elapsed = time.time() - started_at
    print()
    print("=" * 60)
    print(f"Project:        {project_id}")
    print(f"Mode:           {'DRY RUN' if dry_run else 'LIVE'}")
    print(f"Users:          {len(user_docs)}")
    print(f"Chats scanned:  {total_chats}")
    print(f"Msgs scanned:   {total_messages}")
    print(f"Msgs updated:   {total_updated}")
    print(f"Msgs skipped:   {total_skipped} (already had userId)")
    print(f"Elapsed:        {elapsed:.1f}s")
    print("=" * 60)

    if total_messages == 0:
        print("WARNING: scanned zero messages. Wrong project? Wrong credentials?")
        return 1
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="GCP project id")
    parser.add_argument("--dry-run", action="store_true", help="No writes")
    parser.add_argument("--user", default=None, help="Restrict to one uid")
    args = parser.parse_args()
    sys.exit(backfill(args.project, args.dry_run, args.user))


if __name__ == "__main__":
    main()
