"""Replace <ruby><rt> tags with <span class="zh-cmn"> font wrappers in existing messages.

Strips ruby/rt markup down to base characters and wraps paragraphs in
<span class="zh-cmn">. Original content preserved in contentBeforeRubyReplace.

Usage:
    source .venv/bin/activate
    python test_scripts/replace_ruby_with_font.py --dry-run
    python test_scripts/replace_ruby_with_font.py --chat <id> --dry-run
    python test_scripts/replace_ruby_with_font.py --apply
"""

import argparse
import re
import sys
import time

import firebase_admin
from firebase_admin import firestore

PROJECT_ID = "wz-cloud-claude"
USER_ID = "xoBY9nLz8ObwvIRPdJ855EBmAlv2"

CJK_RE = re.compile(r'[一-鿿]')


def strip_ruby(content):
    """Remove <ruby>/<rt> tags, keeping only the base characters."""
    out = content
    out = re.sub(r'<rt>[^<]*</rt>', '', out)
    out = re.sub(r'</?ruby>', '', out)
    return out


def is_primarily_cjk(text):
    """Return True if the text is primarily CJK characters (not English with a few CJK words)."""
    plain = re.sub(r'<[^>]+>', '', text)
    plain = re.sub(r'[\s\*\#\-\:\,\.\!\?\;\'\"\(\)\[\]]+', '', plain)
    if not plain:
        return False
    cjk_count = len(CJK_RE.findall(plain))
    return cjk_count / len(plain) > 0.3


def wrap_cmn_paragraphs(content):
    """Wrap CJK-bearing paragraphs in <span class="zh-cmn"> if not already wrapped.
    Only wraps lines that are primarily CJK (not English with a few Chinese words)."""
    if not CJK_RE.search(content):
        return content
    if 'class="zh-cmn"' in content:
        return content

    paragraphs = re.split(r'\n\n+', content)
    wrapped = []
    for para in paragraphs:
        if is_primarily_cjk(para) and 'class="zh-yue"' not in para and not para.startswith('**'):
            lines = para.split('\n')
            new_lines = []
            for line in lines:
                if is_primarily_cjk(line) and 'class="zh-yue"' not in line and not line.startswith('**'):
                    line = f'<span class="zh-cmn">{line}</span>'
                new_lines.append(line)
            wrapped.append('\n'.join(new_lines))
        else:
            wrapped.append(para)
    return '\n\n'.join(wrapped)


def process_content(content):
    """Full pipeline: strip ruby → wrap in zh-cmn."""
    if '<ruby>' not in content and '<rt>' not in content:
        return None
    out = strip_ruby(content)
    out = wrap_cmn_paragraphs(out)
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--project", default=PROJECT_ID)
    p.add_argument("--chat", help="Single chat ID")
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()
    dry_run = not args.apply

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": args.project})
    db = firestore.client()

    chats_ref = db.collection("chats").document(USER_ID).collection("conversations")

    if args.chat:
        chat_ids = [args.chat]
    else:
        all_chats = list(chats_ref.stream())
        chat_ids = [c.id for c in all_chats]

    print(f"Mode: {'DRY RUN' if dry_run else 'APPLY'}  chats={len(chat_ids)}")
    started = time.time()

    total_msgs = 0
    total_replaced = 0
    total_skipped = 0

    for cid in chat_ids:
        chat_ref = chats_ref.document(cid)
        chat_doc = chat_ref.get().to_dict() or {}
        title = chat_doc.get("title", "(untitled)")

        msgs = list(chat_ref.collection("messages").order_by("timestamp").stream())
        ruby_msgs = []
        for m in msgs:
            d = m.to_dict() or {}
            content = d.get("content", "")
            if d.get("role") == "assistant" and ("<ruby>" in content or "<rt>" in content):
                ruby_msgs.append((m, d))

        if not ruby_msgs:
            continue

        print(f"\n{'='*60}")
        print(f"  [{cid[:10]}] '{title}' — {len(ruby_msgs)} msgs with ruby tags")

        for m_snap, m_data in ruby_msgs:
            old = m_data.get("content", "")
            new = process_content(old)
            if new is None:
                total_skipped += 1
                continue

            total_msgs += 1
            old_len = len(old)
            new_len = len(new)
            reduction = ((old_len - new_len) / old_len * 100) if old_len else 0

            print(f"    {m_snap.id[:12]}: {old_len}ch → {new_len}ch ({reduction:.0f}% smaller)")

            # Show sample
            old_sample = old[:120].replace('\n', '\\n')
            new_sample = new[:120].replace('\n', '\\n')
            print(f"      OLD: {old_sample}...")
            print(f"      NEW: {new_sample}...")

            if not dry_run:
                m_snap.reference.update({
                    "content": new,
                    "contentBeforeRubyReplace": old,
                })
                total_replaced += 1

    elapsed = time.time() - started
    print(f"\n{'='*60}")
    print(f"SUMMARY ({elapsed:.1f}s)")
    print(f"  Messages with ruby: {total_msgs}")
    print(f"  Replaced: {total_replaced}")
    print(f"  Skipped: {total_skipped}")


if __name__ == "__main__":
    sys.exit(main() or 0)
