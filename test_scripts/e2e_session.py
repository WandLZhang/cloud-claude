#!/usr/bin/env python3
"""
Browser session for end-to-end tests, signed in as the throwaway Firebase user zz-persist-test.

  functions/chat/.venv/bin/python test_scripts/e2e_session.py            # write the session file
  functions/chat/.venv/bin/python test_scripts/e2e_session.py --cleanup  # delete the user's chats and the user

The session file holds a refresh token, so it's written 0600 and never printed. Playwright scripts
(test-navigation.js) put it in IndexedDB, where Firebase Auth looks for the signed-in user. Every
chat the tests create lives under chats/zz-persist-test/, and --cleanup deletes all of it.
"""

import json
import os
import sys
import time
import urllib.request

import test_chat_persist as t

SESSION_FILE = "/tmp/cloud-claude-e2e/session.json"


def mint():
    api_key = next(line.split("=", 1)[1].strip() for line in open(t.ENV_FILE)
                   if line.startswith("REACT_APP_FIREBASE_API_KEY="))
    custom = t.auth.create_custom_token(t.TEST_UID).decode()
    req = urllib.request.Request(
        f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={api_key}",
        data=json.dumps({"token": custom, "returnSecureToken": True}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.loads(r.read())
    now_ms = int(time.time() * 1000)
    user = {"uid": t.TEST_UID, "emailVerified": False, "isAnonymous": False, "providerData": [],
            "stsTokenManager": {"refreshToken": out["refreshToken"], "accessToken": out["idToken"],
                                "expirationTime": now_ms + int(out["expiresIn"]) * 1000},
            "createdAt": str(now_ms), "lastLoginAt": str(now_ms), "apiKey": api_key, "appName": "[DEFAULT]"}
    os.makedirs(os.path.dirname(SESSION_FILE), exist_ok=True)
    fd = os.open(SESSION_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"apiKey": api_key, "user": user}, f)
    print(f"session for {t.TEST_UID} saved to {SESSION_FILE} (0600)")


def cleanup():
    chats = list(t.db.collection("chats").document(t.TEST_UID).collection("conversations").stream())
    for chat in chats:
        t.db.recursive_delete(chat.reference)
    try:
        t.auth.delete_user(t.TEST_UID)
        user_note = "deleted the user"
    except t.auth.UserNotFoundError:
        user_note = "the user was already gone"
    if os.path.exists(SESSION_FILE):
        os.remove(SESSION_FILE)
    print(f"deleted {len(chats)} chats of {t.TEST_UID}: {[c.id for c in chats]}; {user_note}")


if __name__ == "__main__":
    cleanup() if "--cleanup" in sys.argv else mint()
