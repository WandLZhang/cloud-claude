#!/usr/bin/env python3
"""
Tests that the chat function saves an assistant reply to Firestore itself (persist mode), so the
reply survives the browser leaving, and that it reports progress as soon as the request starts.

Runs against a real function, real Firestore and real Vertex. Local run:
  cd functions/chat && GOOGLE_CLOUD_PROJECT=wz-cloud-claude GOOGLE_CLOUD_QUOTA_PROJECT=wz-cloud-claude \
    .venv/bin/functions-framework --target=chat --port=8099
  functions/chat/.venv/bin/python test_scripts/test_chat_persist.py
Against the deployed function, set CHAT_URL=https://us-east4-wz-cloud-claude.cloudfunctions.net/chat

Signs in as the throwaway Firebase user zz-persist-test with a minted custom token, writes only
under chats/zz-persist-test/, and deletes its test conversations and the test user at the end.
Every request uses the fast model with thinking off, so a full run costs a few cents.
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

import firebase_admin
from firebase_admin import auth, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

CHAT_URL = os.environ.get("CHAT_URL", "http://localhost:8099/")
PROJECT_ID = "wz-cloud-claude"
TEST_UID = "zz-persist-test"
FAST_MODEL = "claude-sonnet-4-6"  # the function's MODEL_FAST
ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
# Bill the Auth admin calls (deleting the test user) to this project, not the ADC default.
os.environ.setdefault("GOOGLE_CLOUD_QUOTA_PROJECT", PROJECT_ID)

firebase_admin.initialize_app(options={
    "projectId": PROJECT_ID,
    "serviceAccountId": "firebase-adminsdk-fbsvc@wz-cloud-claude.iam.gserviceaccount.com",
})
db = firestore.client()
created_chats = []


def id_token():
    """A real Firebase ID token for TEST_UID: mint a custom token, exchange it like a client would."""
    custom = auth.create_custom_token(TEST_UID).decode()
    api_key = next(line.split("=", 1)[1].strip() for line in open(ENV_FILE)
                   if line.startswith("REACT_APP_FIREBASE_API_KEY="))
    req = urllib.request.Request(
        f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={api_key}",
        data=json.dumps({"token": custom, "returnSecureToken": True}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["idToken"]


def new_placeholder(title="persist test", title_source=None, content="test"):
    """A conversation with one user message and the empty streaming reply the app creates for it.
    `title_source` is the chat's titleSource: 'auto' for a new chat from the app, 'manual' after a
    rename, None for a chat from before titles were tracked."""
    chat = db.collection("chats").document(TEST_UID).collection("conversations").document()
    fields = {"title": title, "lastMessage": "", "createdAt": firestore.SERVER_TIMESTAMP,
              "updatedAt": firestore.SERVER_TIMESTAMP}
    if title_source:
        fields["titleSource"] = title_source
    chat.set(fields)
    created_chats.append(chat)
    user_msg = chat.collection("messages").document()
    user_msg.set({"role": "user", "content": content, "userId": TEST_UID,
                  "timestamp": firestore.SERVER_TIMESTAMP})
    reply = chat.collection("messages").document()
    reply.set({"role": "assistant", "content": "", "isStreaming": True, "replyTo": user_msg.id,
               "userId": TEST_UID, "timestamp": firestore.SERVER_TIMESTAMP})
    return chat, reply


def payload(prompt, chat=None, reply=None, **extra):
    p = {"messages": [{"role": "user", "content": prompt}], "use_fast_model": True,
         "disable_thinking": True, **extra}
    if reply is not None:
        p["persist"] = {"chat_id": chat.id, "message_id": reply.id}
    return p


def post(body, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(CHAT_URL, data=json.dumps(body).encode(), headers=headers)
    return urllib.request.urlopen(req, timeout=300)


def events(resp, t0):
    """Yield (seconds since t0, event) for each SSE data line; comment lines are keepalives."""
    for raw in resp:
        line = raw.decode().rstrip("\n")
        if line.startswith("data: "):
            yield time.time() - t0, json.loads(line[6:])


def wait_finished(reply, timeout):
    """Poll the reply doc until the server marks it finished, or give up after `timeout` seconds."""
    deadline = time.time() + timeout
    doc = reply.get().to_dict()
    while doc.get("isStreaming") is not False and time.time() < deadline:
        time.sleep(2)
        doc = reply.get().to_dict()
    return doc


def report(name, checks):
    for label, ok in checks.items():
        print(f"  {label}: {'PASS' if ok else 'FAIL'}")
    passed = all(checks.values())
    print(f"{'PASS' if passed else 'FAIL'} {name}\n")
    return passed


def test_status_arrives_first(token):
    chat, reply = new_placeholder()
    t0 = time.time()
    evs = list(events(post(payload("Reply with the single word OK.", chat, reply), token), t0))
    first_t, first = evs[0]
    print(f"  first event after {first_t:.1f}s: {first}")
    return report("status arrives first", {
        "first event is a status": first.get("type") == "status",
        "first event within 5 s": first_t < 5,
    })


def test_saves_reply(token):
    chat, reply = new_placeholder()
    text, done = "", {}
    for _, ev in events(post(payload("Reply with exactly: persist works", chat, reply), token), time.time()):
        if ev["type"] == "chunk":
            text += ev["text"]
        elif ev["type"] == "done":
            done = ev
    doc = wait_finished(reply, 30)
    chat_doc = chat.get().to_dict()
    print(f"  streamed {text!r}; saved {doc.get('content')!r}, model {doc.get('model')!r}")
    return report("saves the reply", {
        "reply marked finished": doc.get("isStreaming") is False,
        "saved content matches the stream": bool(text.strip()) and doc.get("content") == done.get("content") == text,
        "model saved": doc.get("model") == FAST_MODEL,
        "status cleared": doc.get("status") is None,
        "server update time saved": doc.get("streamUpdatedAt") is not None,
        "chat lastMessage updated": chat_doc.get("lastMessage") == doc.get("content"),
    })


def test_saves_thinking_time(token):
    chat, reply = new_placeholder()
    prompt = "Think it through step by step: how many primes are there below 100? Answer with just the number."
    done = {}
    for _, ev in events(post(payload(prompt, chat, reply, disable_thinking=False), token), time.time()):
        if ev["type"] == "done":
            done = ev
    doc = wait_finished(reply, 120)
    print(f"  thinking {len(doc.get('thinking') or '')} chars, thinkingSeconds {doc.get('thinkingSeconds')!r}, "
          f"done event {done.get('thinking_seconds')!r}")
    return report("saves how long the reply thought", {
        "reply has thinking text": bool(doc.get("thinking")),
        "thinkingSeconds saved and positive": isinstance(doc.get("thinkingSeconds"), (int, float))
        and doc["thinkingSeconds"] > 0,
        "done event carries the same value": done.get("thinking_seconds") == doc.get("thinkingSeconds"),
    })


def test_survives_disconnect(token):
    chat, reply = new_placeholder()
    resp = post(payload("Count from 1 to 200, one number per line, nothing else.", chat, reply), token)
    first = next(events(resp, time.time()))
    resp.close()
    print(f"  closed the connection after the first event: {first[1]}")
    doc = wait_finished(reply, 60)
    content = doc.get("content") or ""
    print(f"  saved {len(content)} chars; ends with {content[-12:]!r}")
    return report("survives the client disconnecting", {
        "reply marked finished": doc.get("isStreaming") is False,
        "whole reply saved": "199" in content and "200" in content,
    })


def test_saves_error(token):
    chat, reply = new_placeholder()
    # Bytes that aren't an image, sent as a PNG: the API rejects them. (A 6.0 MB base64 image was the
    # trigger until 2026-11-23, when Vertex started accepting it.)
    b64 = base64.b64encode(os.urandom(4000)).decode()
    body = payload("Describe this image.", chat, reply,
                   image={"url": f"data:image/png;base64,{b64}", "type": "image/png"})
    evs = [ev for _, ev in events(post(body, token), time.time())]
    doc = wait_finished(reply, 30)
    print(f"  events {[e['type'] for e in evs]}; saved error {doc.get('error')!r}")
    error = doc.get("error") or ""
    return report("saves an error", {
        "error event streamed": any(e["type"] == "error" for e in evs),
        "reply marked finished": doc.get("isStreaming") is False,
        "error text saved": "image" in error.lower(),
        "the API's message, not the raw exception dump": not error.startswith("Error code"),
    })


def test_rejects_bad_token(token):
    chat, reply = new_placeholder()
    try:
        resp = post(payload("Reply with the single word OK.", chat, reply), token="not-a-real-token")
        list(events(resp, time.time()))
        status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
    doc = reply.get().to_dict()
    print(f"  HTTP {status}; reply doc {doc}")
    return report("rejects a bad token", {
        "HTTP 401": status == 401,
        "reply left untouched": doc.get("isStreaming") is True and doc.get("content") == "",
    })


def test_rejects_unknown_message(token):
    chat, _ = new_placeholder()
    missing = chat.collection("messages").document()  # an ID with no doc behind it
    try:
        resp = post(payload("Reply with the single word OK.", chat, missing), token)
        list(events(resp, time.time()))
        status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
    print(f"  HTTP {status}; doc created: {missing.get().exists}")
    return report("rejects a message that doesn't exist", {
        "HTTP 404": status == 404,
        "no doc created": not missing.get().exists,
    })


TITLE_PROMPT = "What can I use instead of buttermilk in pancakes? Answer in one sentence."
EXAMPLE_TITLES = {"Japanese と思います plain-form rule", "Cantonese greetings with Jyutping",
                  "Toddler fever and Tylenol dosing", "Lisbon four-day itinerary", "Sorting a Python dict by value"}


def wait_title(chat, timeout):
    """Poll the chat doc until the function gives it an AI title, or give up after `timeout` seconds."""
    deadline = time.time() + timeout
    doc = chat.get().to_dict()
    while doc.get("titleSource") != "ai" and time.time() < deadline:
        time.sleep(1)
        doc = chat.get().to_dict()
    return doc


def test_titles_a_new_chat(token):
    auto = "What can I use instead of buttermilk in pan..."
    chat, reply = new_placeholder(title=auto, title_source="auto", content=TITLE_PROMPT)
    for _ in events(post(payload(TITLE_PROMPT, chat, reply), token), time.time()):
        pass
    doc = wait_title(chat, 30)
    title = doc.get("title") or ""
    print(f"  title {title!r}, titleSource {doc.get('titleSource')!r}")
    return report("titles a new chat from its first message", {
        "titleSource is ai": doc.get("titleSource") == "ai",
        "the automatic title was replaced": bool(title) and title != auto,
        "not copied from the prompt's examples": title not in EXAMPLE_TITLES,
        "names the subject": "buttermilk" in title.lower(),
        "2 to 8 words": 2 <= len(title.split()) <= 8,
        "60 characters or fewer": len(title) <= 60,
        "no quotes or ending period": not any(c in title for c in '"“”') and not title.endswith("."),
    })


ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="


def test_titles_instead_of_answering(token):
    """A first message that tells Claude how to answer ("answer in one short sentence") gets a title,
    not an answer. On 2026-11-23 the title model answered such a photo question instead."""
    prompt = "What could have made this image? Think it over, then answer in one short sentence."
    chat, reply = new_placeholder(title="What could have made this image? Think i...", title_source="auto", content=prompt)
    body = payload(prompt, chat, reply, image={"url": f"data:image/png;base64,{ONE_PIXEL_PNG}", "type": "image/png"})
    for _ in events(post(body, token), time.time()):
        pass
    doc = wait_title(chat, 30)
    title = doc.get("title") or ""
    print(f"  title {title!r}, titleSource {doc.get('titleSource')!r}")
    return report("titles a message that asks for a short answer, instead of answering it", {
        "titled on the first message": doc.get("titleSource") == "ai",
        "a title, not a sentence": 2 <= len(title.split()) <= 8 and not title.endswith("."),
    })


def test_waits_for_the_material(token):
    """A saved prompt sent alone ("Translate ...:") has no subject; the title waits for the next message."""
    first = "Translate to colloquial Cantonese and Mandarin:"
    chat, reply1 = new_placeholder(title=first, title_source="auto", content=first)
    for _ in events(post(payload(first, chat, reply1), token), time.time()):
        pass
    time.sleep(8)
    after_first = chat.get().to_dict()
    answer = wait_finished(reply1, 30).get("content") or ""
    user2 = chat.collection("messages").document()
    user2.set({"role": "user", "content": "macaroni and cheese", "userId": TEST_UID, "timestamp": firestore.SERVER_TIMESTAMP})
    reply2 = chat.collection("messages").document()
    reply2.set({"role": "assistant", "content": "", "isStreaming": True, "replyTo": user2.id, "userId": TEST_UID,
                "timestamp": firestore.SERVER_TIMESTAMP})
    body = payload("macaroni and cheese", chat, reply2)
    body["messages"] = [{"role": "user", "content": first}, {"role": "assistant", "content": answer},
                        {"role": "user", "content": "macaroni and cheese"}]
    for _ in events(post(body, token), time.time()):
        pass
    after_second = wait_title(chat, 30)
    print(f"  after the first message {after_first.get('title')!r}/{after_first.get('titleSource')!r}; "
          f"after the second {after_second.get('title')!r}/{after_second.get('titleSource')!r}")
    return report("waits for the material when the first message is only a saved prompt", {
        "first message leaves the automatic title": after_first.get("title") == first and after_first.get("titleSource") == "auto",
        "second message brings an AI title": after_second.get("titleSource") == "ai",
        "the title names the material": "macaroni" in (after_second.get("title") or "").lower(),
    })


def test_keeps_manual_and_older_titles(token):
    manual, _ = new_placeholder(title="My own name", title_source="manual", content=TITLE_PROMPT)
    older, _ = new_placeholder(title="Before titles were tracked", content=TITLE_PROMPT)
    for chat in (manual, older):
        reply = next(chat.collection("messages").where(filter=FieldFilter("role", "==", "assistant")).limit(1).stream()).reference
        for _ in events(post(payload(TITLE_PROMPT, chat, reply), token), time.time()):
            pass
    time.sleep(10)   # longer than a title takes
    manual_doc, older_doc = manual.get().to_dict(), older.get().to_dict()
    print(f"  manual {manual_doc.get('title')!r}/{manual_doc.get('titleSource')!r}; "
          f"older {older_doc.get('title')!r}/{older_doc.get('titleSource')!r}")
    return report("keeps a manual title and leaves an older chat alone", {
        "manual title kept": manual_doc.get("title") == "My own name" and manual_doc.get("titleSource") == "manual",
        "older chat untouched": older_doc.get("title") == "Before titles were tracked" and "titleSource" not in older_doc,
    })


def test_no_persist_unchanged(token):
    evs = [ev for _, ev in events(post(payload("Reply with the single word OK.")), time.time())]
    done = evs[-1] if evs else {}
    print(f"  events {[e['type'] for e in evs]}; done content {done.get('content')!r}")
    return report("works without persist, as before", {
        "text streamed": any(e["type"] == "chunk" for e in evs),
        "ends with done and content": done.get("type") == "done" and bool((done.get("content") or "").strip()),
    })


if __name__ == "__main__":
    print(f"CHAT PERSIST TESTS against {CHAT_URL}\n")
    token = id_token()
    results = {}
    try:
        for test in (test_status_arrives_first, test_saves_reply, test_saves_thinking_time, test_survives_disconnect,
                     test_saves_error, test_rejects_bad_token, test_rejects_unknown_message,
                     test_titles_a_new_chat, test_titles_instead_of_answering, test_waits_for_the_material,
                     test_keeps_manual_and_older_titles,
                     test_no_persist_unchanged):
            print(f"--- {test.__name__}")
            try:
                results[test.__name__] = test(token)
            except Exception as e:  # noqa: BLE001
                print(f"  ERROR {type(e).__name__}: {e}\nFAIL {test.__name__}\n")
                results[test.__name__] = False
    finally:
        for chat in created_chats:
            db.recursive_delete(chat)
        try:
            auth.delete_user(TEST_UID)
        except Exception as e:  # noqa: BLE001
            print(f"WARNING: could not delete test user {TEST_UID}: {e}")
    failed = [name for name, ok in results.items() if not ok]
    print(f"{len(results) - len(failed)} of {len(results)} passed" + (f"; failed: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)
