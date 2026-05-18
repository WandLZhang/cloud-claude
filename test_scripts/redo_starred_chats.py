"""Re-translate all starred chats using current Firestore template prompts.

Fetches starred chats automatically (no hardcoded list). For each chat,
replays user→assistant pairs through the chat function with the updated
system prompt, preserving image references and message ordering.

In --dry-run mode (default): prints old-vs-new comparison without writing.
With --apply: writes new content + stashes original in contentBeforeRedo.

Usage:
    source .venv/bin/activate
    python test_scripts/redo_starred_chats.py --project wz-cloud-claude --dry-run
    python test_scripts/redo_starred_chats.py --project wz-cloud-claude --chat <id> --dry-run
    python test_scripts/redo_starred_chats.py --project wz-cloud-claude --apply
"""

import argparse
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

TEMPLATE_EVERYDAY = "53RE9M0MEVqulQRv0SGK"
TEMPLATE_MANDARIN_BOOKS = "g8QTqrl3O40ex8pmBSvf"
TEMPLATE_ENGLISH_BOOKS = "K731ZzMJXnlP85BNCFmY"

WRITTEN_MARKERS = ['不過', '什麼時候', '為什麼', '沒有', '現在', '東西', '這樣', '喜歡', '他們', '她們', '可以']
CJK_RE = re.compile(r'[一-鿿]')


def detect_template_id(title, first_content):
    if 'in English you will translate' in first_content or 'Play with' in title or 'Play With' in title:
        return TEMPLATE_ENGLISH_BOOKS
    if CJK_RE.search(title) or '翻譯' in first_content or '翻译' in first_content or 'Mandarin' in first_content:
        return TEMPLATE_MANDARIN_BOOKS
    return TEMPLATE_EVERYDAY


def quality_check(content):
    has_zhyue = 'class="zh-yue"' in content
    has_ruby = '<ruby>' in content
    has_notes = bool(re.search(r'Note|---|💡|Would you like', content))
    cant_section = content.split('Cantonese')[-1] if 'Cantonese' in content else content
    written_count = sum(1 for wm in WRITTEN_MARKERS if wm in cant_section)
    return {
        'zh_yue': has_zhyue,
        'ruby': has_ruby,
        'notes': has_notes,
        'written_markers': written_count,
        'length': len(content),
    }


def call_chat(api_messages, system_prompt, image=None, web_search=True, timeout=120):
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

    for line in response_text.split("\n"):
        if line.startswith("data: "):
            try:
                data = json.loads(line[6:])
            except json.JSONDecodeError:
                continue
            if data.get("type") == "done":
                return data.get("content", ""), data.get("usage", {})
    return "", {}


def get_starred_chats(db):
    chats_ref = db.collection("chats").document(USER_ID).collection("conversations")
    return list(chats_ref.where("isStarred", "==", True).stream())


def process_chat(db, chat_id, templates, dry_run=True):
    chat_ref = db.collection("chats").document(USER_ID).collection("conversations").document(chat_id)
    chat_doc = chat_ref.get().to_dict() or {}
    title = chat_doc.get("title", "(untitled)")

    msgs_snap = list(chat_ref.collection("messages").order_by("timestamp").stream())
    msgs = [(m, m.to_dict() or {}) for m in msgs_snap]
    if not msgs:
        print(f"  [{chat_id[:8]}] '{title}' — no messages, skipping")
        return

    first_user = next(((s, d) for s, d in msgs if d.get("role") == "user"), None)
    if not first_user:
        print(f"  [{chat_id[:8]}] '{title}' — no user msg, skipping")
        return

    first_content = first_user[1].get("content", "")
    template_id = detect_template_id(title, first_content)
    sys_prompt = templates.get(template_id, "")
    if not sys_prompt:
        print(f"  [{chat_id[:8]}] '{title}' — template {template_id} not found, skipping")
        return

    user_msgs = [(s, d) for s, d in msgs if d.get("role") == "user"]
    asst_msgs = [(s, d) for s, d in msgs if d.get("role") == "assistant"]

    print(f"\n{'='*60}")
    print(f"  [{chat_id[:8]}] '{title}'")
    print(f"  template={template_id[:8]}  users={len(user_msgs)}  assts={len(asst_msgs)}  mode={'DRY' if dry_run else 'APPLY'}")

    conversation_history = []
    asst_idx = 0
    improved = 0
    regressed = 0
    unchanged = 0

    for u_idx, (u_snap, u_data) in enumerate(user_msgs):
        content = u_data.get("content", "")
        image = u_data.get("image")

        if asst_idx >= len(asst_msgs):
            break

        a_snap, a_data = asst_msgs[asst_idx]
        old_content = a_data.get("content", "")

        if not old_content or not CJK_RE.search(old_content):
            conversation_history.append({"role": "user", "content": content, **({"image": {"url": image["url"], "type": image.get("type", "image/jpeg")}} if image else {})})
            conversation_history.append({"role": "assistant", "content": old_content})
            asst_idx += 1
            continue

        api_msg = {"role": "user", "content": content}
        if image:
            api_msg["image"] = {"url": image["url"], "type": image.get("type", "image/jpeg")}
        api_messages = list(conversation_history) + [api_msg]

        try:
            new_content, usage = call_chat(api_messages, sys_prompt, image=image, web_search=True)
        except Exception as e:
            print(f"    turn {u_idx+1} ERROR: {e}")
            conversation_history.append(api_msg)
            conversation_history.append({"role": "assistant", "content": old_content})
            asst_idx += 1
            continue

        if not new_content:
            print(f"    turn {u_idx+1} EMPTY response, keeping old")
            conversation_history.append(api_msg)
            conversation_history.append({"role": "assistant", "content": old_content})
            asst_idx += 1
            continue

        old_q = quality_check(old_content)
        new_q = quality_check(new_content)

        old_flags = []
        new_flags = []
        if old_q['zh_yue']: old_flags.append('zh-yue')
        if old_q['ruby']: old_flags.append('ruby')
        if old_q['notes']: old_flags.append('NOTES')
        if old_q['written_markers']: old_flags.append(f'{old_q["written_markers"]}x書面')
        if new_q['zh_yue']: new_flags.append('zh-yue')
        if new_q['ruby']: new_flags.append('ruby')
        if new_q['notes']: new_flags.append('NOTES')
        if new_q['written_markers']: new_flags.append(f'{new_q["written_markers"]}x書面')

        better = (new_q['zh_yue'] >= old_q['zh_yue'] and
                  new_q['written_markers'] <= old_q['written_markers'] and
                  not new_q['notes'])
        worse = (old_q['zh_yue'] and not new_q['zh_yue']) or (new_q['written_markers'] > old_q['written_markers'])

        if worse:
            status = "REGRESS"
            regressed += 1
        elif better and (new_q['written_markers'] < old_q['written_markers'] or not old_q['zh_yue']):
            status = "IMPROVED"
            improved += 1
        else:
            status = "OK"
            unchanged += 1

        in_tok = usage.get('input_tokens', '?')
        out_tok = usage.get('output_tokens', '?')
        print(f"    turn {u_idx+1}: {status}  old=[{','.join(old_flags) or 'bare'} {old_q['length']}ch]  new=[{','.join(new_flags) or 'bare'} {new_q['length']}ch]  in={in_tok} out={out_tok}")

        if not dry_run and not worse:
            a_snap.reference.update({
                "content": new_content,
                "contentBeforeRedo": old_content,
            })

        conversation_history.append(api_msg)
        conversation_history.append({"role": "assistant", "content": new_content})
        asst_idx += 1

    if not dry_run:
        chat_ref.update({"systemPrompt": sys_prompt, "enableWebSearch": True})

    print(f"  RESULT: improved={improved} regressed={regressed} unchanged={unchanged}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--project", default=PROJECT_ID)
    p.add_argument("--chat", help="Single chat ID")
    p.add_argument("--apply", action="store_true", help="Write changes (default is dry-run)")
    args = p.parse_args()
    dry_run = not args.apply

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": args.project})
    db = firestore.client()

    print("Loading templates from Firestore...")
    templates = {}
    for tid in [TEMPLATE_EVERYDAY, TEMPLATE_MANDARIN_BOOKS, TEMPLATE_ENGLISH_BOOKS]:
        doc = db.collection("prompts").document(USER_ID).collection("userPrompts").document(tid).get().to_dict()
        if doc:
            templates[tid] = doc.get("systemPrompt", "")
            print(f"  {tid[:8]}: '{doc.get('title','')}' — {len(templates[tid])} chars")

    if args.chat:
        chat_ids = [args.chat]
        print(f"\nProcessing single chat: {args.chat}")
    else:
        starred = get_starred_chats(db)
        chat_ids = [s.id for s in starred]
        print(f"\nFound {len(chat_ids)} starred chats")

    print(f"Mode: {'DRY RUN' if dry_run else 'APPLY'}\n")
    started = time.time()

    for cid in chat_ids:
        try:
            process_chat(db, cid, templates, dry_run=dry_run)
        except Exception as e:
            print(f"  [{cid[:8]}] FATAL: {e}")

    elapsed = time.time() - started
    print(f"\nDone in {elapsed:.1f}s")


if __name__ == "__main__":
    sys.exit(main() or 0)
