"""Archive + delete old unstarred chats.

Bundles each chat's doc + all messages into JSON, uploads to GCS at
gs://wz-cloud-claude.firebasestorage.app/chat-archive/{userId}/{chatId}.json,
then deletes the chat + messages from Firestore.

Selection rule: keep starred chats AND chats created on/after CUTOFF.
Everything else gets archived + deleted.

Usage:
    source .venv/bin/activate
    python test_scripts/archive_and_delete_old_chats.py --project wz-cloud-claude --dry-run --limit 3
    python test_scripts/archive_and_delete_old_chats.py --project wz-cloud-claude --limit 1
    python test_scripts/archive_and_delete_old_chats.py --project wz-cloud-claude

Flags:
    --project ID      GCP project (default wz-cloud-claude)
    --user UID        Restrict to single user (default: known USER_ID)
    --cutoff YYYYMMDD Cutoff date in UTC (default 2026-05-01)
    --dry-run         Walk + print, no GCS upload, no Firestore delete
    --limit N         Cap chats processed (smoke test)

Restoration (manual):
    Read JSON from GCS, write chat doc back to Firestore, then iterate
    messages and write each back. The JSON preserves all original IDs and
    timestamps. See restore_chat() at the bottom of this file for a helper.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import firestore
from google.cloud import storage

PROJECT_ID = "wz-cloud-claude"
USER_ID = "xoBY9nLz8ObwvIRPdJ855EBmAlv2"
BUCKET_NAME = "wz-cloud-claude.firebasestorage.app"
ARCHIVE_PREFIX = "chat-archive"  # gs://{bucket}/chat-archive/{userId}/{chatId}.json

DEFAULT_CUTOFF = datetime(2026, 5, 1, 0, 0, 0, tzinfo=timezone.utc)
BATCH_SIZE = 500  # Firestore batch write limit


def serialize(value):
    """Recursively convert Firestore types to JSON-serializable forms."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serialize(v) for v in value]
    # Firestore reference, GeoPoint, etc — fall back to string
    return str(value)


def archive_chat(db, bucket, user_id, chat_doc_ref, dry_run=False):
    """Archive one chat to GCS and delete from Firestore.
    Returns (success, message_count, json_size_bytes)."""
    chat_id = chat_doc_ref.id
    chat_snap = chat_doc_ref.get()
    if not chat_snap.exists:
        return False, 0, 0
    chat_data = chat_snap.to_dict() or {}

    # Read all messages
    msg_snaps = list(chat_doc_ref.collection("messages").order_by("timestamp").stream())
    messages = []
    for m in msg_snaps:
        d = m.to_dict() or {}
        messages.append({"id": m.id, **serialize(d)})

    bundle = {
        "chatId": chat_id,
        "userId": user_id,
        "archivedAt": datetime.now(timezone.utc).isoformat(),
        "chat": serialize(chat_data),
        "messages": messages,
    }
    bundle_json = json.dumps(bundle, ensure_ascii=False, indent=2)

    if dry_run:
        return True, len(messages), len(bundle_json)

    # Upload to GCS
    blob_name = f"{ARCHIVE_PREFIX}/{user_id}/{chat_id}.json"
    blob = bucket.blob(blob_name)
    blob.upload_from_string(bundle_json, content_type="application/json")

    # Verify upload by reading back
    if not blob.exists():
        raise RuntimeError(f"Upload verify failed: blob {blob_name} not found after upload")
    # Optional: verify size matches
    blob.reload()
    if blob.size != len(bundle_json.encode("utf-8")):
        raise RuntimeError(f"Upload verify failed: size mismatch (uploaded {len(bundle_json)} != stored {blob.size})")

    # Delete messages in batches
    for i in range(0, len(msg_snaps), BATCH_SIZE):
        batch = db.batch()
        for m in msg_snaps[i : i + BATCH_SIZE]:
            batch.delete(m.reference)
        batch.commit()

    # Delete chat doc
    chat_doc_ref.delete()

    return True, len(messages), len(bundle_json)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--project", default=PROJECT_ID)
    p.add_argument("--user", default=USER_ID)
    p.add_argument("--cutoff", default="20260501", help="YYYYMMDD UTC, default 20260501")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit", type=int, default=0, help="Cap chats processed (0 = no cap)")
    args = p.parse_args()

    cutoff = datetime.strptime(args.cutoff, "%Y%m%d").replace(tzinfo=timezone.utc)

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": args.project})
    db = firestore.client()
    storage_client = storage.Client(project=args.project)
    bucket = storage_client.bucket(BUCKET_NAME)

    print(f"Mode={'DRY' if args.dry_run else 'LIVE'} project={args.project} user={args.user}")
    print(f"Cutoff: {cutoff.isoformat()}  (chats created BEFORE this AND not starred → archive+delete)")
    print(f"GCS dest: gs://{BUCKET_NAME}/{ARCHIVE_PREFIX}/{args.user}/<chatId>.json")
    print()

    convs_root = db.collection("chats").document(args.user).collection("conversations")
    targets = []
    keep_starred = 0
    keep_recent = 0
    no_created = 0
    for doc_ref in convs_root.list_documents():
        snap = doc_ref.get()
        if not snap.exists:
            continue
        d = snap.to_dict() or {}
        if d.get("isStarred"):
            keep_starred += 1
            continue
        created = d.get("createdAt")
        if created and created >= cutoff:
            keep_recent += 1
            continue
        if not created:
            no_created += 1  # treat as old (no createdAt = orphan, archive it)
        targets.append(doc_ref)

    print(f"Plan: keep_starred={keep_starred}  keep_recent={keep_recent}  archive={len(targets)}  (of which no createdAt: {no_created})")
    if args.limit and len(targets) > args.limit:
        print(f"Capping at --limit {args.limit}")
        targets = targets[: args.limit]
    print(f"Will process {len(targets)} chats.")
    print()

    started = time.time()
    success = 0
    failed = 0
    total_msgs = 0
    total_bytes = 0

    for i, doc_ref in enumerate(targets, 1):
        try:
            ok, mc, sz = archive_chat(db, bucket, args.user, doc_ref, dry_run=args.dry_run)
            if ok:
                success += 1
                total_msgs += mc
                total_bytes += sz
                print(f"[{i}/{len(targets)}] {doc_ref.id} → {mc} msgs, {sz} bytes {'[DRY]' if args.dry_run else 'archived+deleted'}")
            else:
                print(f"[{i}/{len(targets)}] {doc_ref.id} → SKIPPED (chat doc missing)")
        except Exception as e:
            failed += 1
            print(f"[{i}/{len(targets)}] {doc_ref.id} → FAILED: {e}", file=sys.stderr)
        sys.stdout.flush()

    elapsed = time.time() - started
    print()
    print(f"=== SUMMARY ({elapsed:.1f}s) ===")
    print(f"Mode: {'DRY' if args.dry_run else 'LIVE'}")
    print(f"Success: {success}/{len(targets)}")
    print(f"Failed:  {failed}")
    print(f"Total messages archived: {total_msgs}")
    print(f"Total JSON bytes: {total_bytes:,} ({total_bytes/1024/1024:.1f} MB)")
    return 0 if failed == 0 else 1


# ---------- Restore helper (not invoked from main) ----------

def restore_chat(user_id, chat_id, project=PROJECT_ID):
    """Re-import a single archived chat back into Firestore.
    Reads from gs://{bucket}/chat-archive/{user_id}/{chat_id}.json.

    Note: timestamps are restored as ISO strings rather than Firestore
    Timestamps. The frontend reads them as either, but querying by date may
    be off — use only if you genuinely want the chat back in the live UI.
    """
    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": project})
    db = firestore.client()
    storage_client = storage.Client(project=project)
    blob = storage_client.bucket(BUCKET_NAME).blob(f"{ARCHIVE_PREFIX}/{user_id}/{chat_id}.json")
    bundle = json.loads(blob.download_as_text())

    chat_ref = db.collection("chats").document(user_id).collection("conversations").document(chat_id)
    chat_ref.set(bundle["chat"])
    for m in bundle["messages"]:
        msg_id = m.pop("id", None)
        if msg_id:
            chat_ref.collection("messages").document(msg_id).set(m)
        else:
            chat_ref.collection("messages").add(m)
    print(f"Restored {chat_id} with {len(bundle['messages'])} messages")


if __name__ == "__main__":
    sys.exit(main())
