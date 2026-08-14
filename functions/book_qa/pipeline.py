"""Book-translation pipeline — rebuild a book chat FROM ITS PAGE PHOTOS.

Shared library. Two entry points run this same code: test_scripts/rebuild_book_chats.py (manual)
and functions/book_qa/main.py (the nightly Cloud Scheduler job). Keep it import-safe: no argparse,
no printing at import time, no filesystem or network work outside a function body.

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
  3. PASS ONE — OCR every page, then decide ONCE for the whole book which Cantonese wording each
     repeated word and refrain gets (the "book sheet"). Children's books run on repetition: the
     same phrase coming back page after page IS the effect, and rendering it three different ways
     destroys the book even when all three readings are good Cantonese. Measured on Grumpy Monkey:
     the source repeats "grumpy" on pages 4,5,7,9,19,20,25 and a 4-page history window produced
     燥底 for the first half and 扭擰 for the second.
  4. PASS TWO — translate each page with the sheet pinned into the system prompt, plus a short
     history window and an explicit per-page instruction. The old path sent an empty user message
     on image turns, so the only instruction in a 70-page chat was the first turn's one-liner.
  5. Write the result onto an assistant doc that is bound to its page with `replyTo`, timestamped
     1 ms after its photo, with the previous text kept in `contentBeforeRebuild`.
  6. Leave the conversation turns between pages alone (corrections and questions you typed), just
     anchored. Flag — do NOT delete — any assistant doc with no page to answer: in 木偶奇遇记 that
     doc holds a real page translation whose photo was never saved. --delete-surplus is opt-in.
  7. Verify: every photo has exactly one reply, and every fixed rendering on the sheet actually got
     used. Refuse to finish otherwise.

Usage:
    source .venv/bin/activate
    python test_scripts/rebuild_book_chats.py --chat QjYqcD7epRfGcIs96t40            # dry run
    python test_scripts/rebuild_book_chats.py --chat QjYqcD7epRfGcIs96t40 --apply
    python test_scripts/rebuild_book_chats.py --all --apply --workers 3
"""

import base64
import concurrent.futures as cf
import datetime
import json
import pathlib
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


OCR_INSTRUCTION = ("Transcribe the printed body text of this children's book page exactly as printed. "
                   "Ignore pinyin/jyutping guides printed above or below the characters, ignore page "
                   "numbers, ignore anything drawn rather than typeset. Output ONLY the text.")

SHEET_SYSTEM = """You are preparing a translator's sheet before a children's picture book is
rendered into colloquial Hong Kong Cantonese (口語, Traditional characters).

Children's books work by REPETITION. The same word, the same refrain and the same sentence frame
come back page after page, and that recurrence IS the effect — the child anticipates it and joins
in. A translation that renders the same English phrase three different ways destroys the book even
if all three renderings are good Cantonese.

Read every page below, then decide ONCE, for the whole book:

1. terms — every word or short phrase the book repeats across pages (the running joke, the
   character trait, the thing everyone says). Choose the single best colloquial HK Cantonese
   rendering and commit to it. Prefer child-facing spoken words over adult or written ones, and
   over a word that names a permanent personality trait when the book means a passing mood.
2. refrains — every sentence or frame that recurs. Fix the whole wording, not just the key word.
   Where the frame recurs with one slot changed, keep the frame identical and change only the slot.
   When the source itself repeats a shape inside one line (too bright, too blue, too sweet), keep
   that shape — but build it out of an authentically Cantonese construction repeated, never out of
   a Mandarin-shaped one chosen because it is easier to repeat. 猛得滯、藍得滯、甜得滯 keeps both the
   triple and the Cantonese; 太猛、太藍、太甜 keeps the triple and loses the Cantonese.
3. voice — one line on the register: who is speaking, to what age, how playful.

Do NOT translate character names, place names or brand names. They stay exactly as printed in the
source; the reader says them in English.

Every "yue" value must be genuinely spoken Hong Kong Cantonese (口語), never 書面語 and never
Mandarin with a few particles added. Where a lively ABB/AAB or onomatopoeic form genuinely fits,
prefer it over a flat word — a list of attested ones is supplied below.

READABILITY: the app draws jyutping above every character with the canto.hk Visual Font, which
covers 54,160 codepoints — so rare but authentic Cantonese characters are fine and preferred.
䒐䒏 for grumpy is right and renders correctly. Only avoid a character if no font would have it.

FORMAT RULES for "yue", because these strings are checked against the finished pages:
- the literal Cantonese only. No parentheses, no gloss, no alternatives, no commentary.
- write ___ (three underscores) for a slot that changes from page to page. Nothing else.
- put all reasoning in "why", never in "yue".

Return ONLY JSON, no quotation marks inside any value:
{"voice":"...",
 "terms":[{"source":"...","yue":"...","why":"<=10 words"}],
 "refrains":[{"source":"...","yue":"..."}]}"""


def ocr_page(image_bytes, mime="image/jpeg"):
    from google.genai import types
    r = _gemini().models.generate_content(
        model="gemini-3.5-flash",
        contents=[types.Part.from_bytes(data=image_bytes, mime_type=mime), OCR_INSTRUCTION],
        config=types.GenerateContentConfig(temperature=0, max_output_tokens=2000))
    return (r.text or "").strip()


def build_book_sheet(model_id, title, page_texts, palette=(), log=print, extra=""):
    """One pass over the WHOLE book before any page is translated.

    This is the fix for the defect the first rebuild shipped. Grumpy Monkey repeats the word
    "grumpy" on pages 4,5,7,9,19,20,25 and the refrain "It's such a wonderful day" on 5,7,19. With a
    4-page history window the translator could not see page 5 from page 19, so the running word came
    out 燥底 for the first half and 扭擰 for the second. The original app run held 扭計 across all
    seven pages precisely because it carried the entire book in context. The sheet buys that global
    consistency back without dragging 70 photos into the last call.
    """
    body = "\n\n".join(f"PAGE {p}\n{t}" for p, t in sorted(page_texts.items()) if t.strip())
    if not body:
        return None
    if extra:
        body += "\n\nIMPORTANT: " + extra
    if palette:
        body += ("\n\nATTESTED VIVID FORMS (Words.hk) you may draw on:\n"
                 + "\n".join(f"- {w} — {g}" for w, g in palette))
    provider, vertex_id = MODELS[model_id]
    raw = ""
    for attempt in range(MAX_RETRIES):
        try:
            if provider == "anthropic":
                with _anthropic().messages.stream(
                        model=vertex_id, max_tokens=MAX_TOKENS["anthropic"],
                        system=[{"type": "text", "text": SHEET_SYSTEM}],
                        thinking={"type": "adaptive"}, output_config={"effort": "max"},
                        messages=[{"role": "user", "content": [{"type": "text",
                                   "text": f"Book: {title}\n\n{body}"}]}]) as st:
                    for _ in st:
                        pass
                    m = st.get_final_message()
                raw = "".join(b.text for b in m.content if getattr(b, "type", None) == "text")
            else:
                from google.genai import types
                r = _gemini().models.generate_content(
                    model=vertex_id, contents=f"Book: {title}\n\n{body}",
                    config=types.GenerateContentConfig(system_instruction=SHEET_SYSTEM,
                                                       max_output_tokens=MAX_TOKENS["gemini"]))
                raw = r.text or ""
            a, b = raw.find("{"), raw.rfind("}")
            sheet = json.loads(raw[a:b + 1])
            log(f"  book sheet: {len(sheet.get('terms', []))} fixed term(s), "
                f"{len(sheet.get('refrains', []))} refrain(s) — voice: {sheet.get('voice', '')[:70]}")
            for t in sheet.get("terms", []):
                log(f"      term    {t.get('source', '')!r} -> {t.get('yue', '')}   ({t.get('why', '')})")
            for r_ in sheet.get("refrains", []):
                log(f"      refrain {r_.get('source', '')[:50]!r} -> {r_.get('yue', '')[:50]}")
            return sheet
        except Exception as e:  # noqa: BLE001
            if attempt == MAX_RETRIES - 1:
                log(f"  book sheet FAILED ({type(e).__name__}: {str(e)[:80]}) — pages run unpinned")
                return None
            time.sleep(2 ** attempt * 2)


# cloud-claude renders Cantonese in the canto.hk Visual Font, which draws jyutping above each
# character (src/index.css: .message-content .zh-yue). Nothing here is tapped — the tap-dictionary
# belongs to the phone apps. So the only real constraint on a word is whether this font has the
# glyph, and with 54,160 codepoints it almost always does: 䒐䒏 (U+4490/U+448F) is covered and
# renders with its jyutping, so the sheet is free to choose the authentic word over a tame one.
CMAP_PATH = HERE / "vf_canto_cmap.json"


def font_codepoints(cache={}):   # noqa: B006 — deliberate module-level memo
    """Codepoints the Visual Font can draw, as [lo, hi] ranges.

    Precomputed by gen_assets.py from public/fonts/VF-Canto-HKEdB.woff2. The font itself is
    16.6 MB, far too large to ship in a function; the ranges are a few KB.
    """
    if "c" not in cache:
        try:
            cp = set()
            for lo, hi in json.loads(CMAP_PATH.read_text())["ranges"]:
                cp.update(range(lo, hi + 1))
            cache["c"] = cp
        except Exception:  # noqa: BLE001
            cache["c"] = set()
    return cache["c"]


def unreadable_terms(sheet):
    """Sheet entries using a character the Visual Font has no glyph for (it would lose its
    jyutping and fall back to a system face)."""
    cps = font_codepoints()
    if not cps or not sheet:
        return []
    out = []
    for kind in ("terms", "refrains"):
        for item in sheet.get(kind, []):
            miss = {c for c in (item.get("yue") or "") if ord(c) > 0x2E80 and ord(c) not in cps}
            if miss:
                out.append((item, "".join(sorted(miss))))
    return out


def sheet_block(sheet, palette):
    """The addendum appended to the system prompt for EVERY page of this book."""
    if not sheet and not palette:
        return ""
    out = ["\n\n## BOOK SHEET — decided once for this whole book. Follow it verbatim.",
           "Children's books run on repetition: the same words coming back is the point. Where a "
           "phrase below appears on this page, use the fixed rendering exactly, even if another "
           "wording would read better in isolation."]
    if sheet:
        if sheet.get("voice"):
            out.append(f"\nVOICE: {sheet['voice']}")
        if sheet.get("terms"):
            out.append("\nFIXED TERMS (same rendering every single time):")
            out += [f"- {t.get('source','')} -> {t.get('yue','')}" for t in sheet["terms"]]
        if sheet.get("refrains"):
            out.append("\nFIXED REFRAINS (reuse the whole frame; change only what the page changes):")
            out += [f"- {r.get('source','')} -> {r.get('yue','')}" for r in sheet["refrains"]]
    out.append("\nNAMES: leave every character, place and brand name exactly as printed in the "
               "source. Do not transliterate them.")
    if palette:
        out.append("\nVIVID FORMS attested in Words.hk (粵典) — reach for these rather than repeating "
                   "one shape. Use only where they genuinely fit:")
        out += [f"- {w} — {g}" for w, g in palette]
    return "\n".join(out)


# Seed shapes for the vividness palette. Every one is verified against the Words.hk corpus at run
# time and silently dropped if it has no entry, so nothing unattested reaches the prompt. Needed
# because ABB/AAB was asserted in the prompt and in the benchmark rubric but grounded in neither:
# across the 529 pages of the first rebuild, the only ABB forms that showed up in any number were
# 靜雞雞 and 慢慢嚟 — the two examples the prompt itself lists.
PALETTE_SEEDS = [
    "靜雞雞", "慢慢嚟", "急急腳", "笑騎騎", "眼濕濕", "面青青", "口噏噏", "立立亂", "傻更更",
    "肥腯腯", "圓碌碌", "黑鼆鼆", "慌失失", "戇居居", "論論盡盡", "濕立立", "熱辣辣", "凍冰冰",
    "軟腍腍", "硬鎁鎁", "甜絲絲", "苦茵茵", "光脫脫", "亂糟糟", "醉醺醺", "喼喼聲", "嘭嘭聲",
    "騰騰震", "騰雞", "鬼馬", "牙擦擦", "沙塵", "論盡", "百厭",
]


def vivid_palette(cache={}, log=print):   # noqa: B006 — deliberate module-level memo
    """Words.hk-verified vivid forms, loaded from the committed asset.

    Verification happens offline in gen_assets.py, not here: the corpus lives in another project
    (wz-data-catalog-demo) and this module runs inside a Cloud Function that should not need
    cross-project RAG access just to build a prompt.
    """
    if not cache:
        try:
            cache["palette"] = [(e["w"], e["gloss"])
                                for e in json.loads((HERE / "palette.json").read_text())]
        except Exception as e:  # noqa: BLE001
            log(f"  vividness palette unavailable ({e}) — continuing without it")
            cache["palette"] = []
        else:
            log(f"  vividness palette: {len(cache['palette'])} attested forms")
    return cache["palette"]


def judge_text(model_id, system, user, max_tokens=8000):
    """Text-only single call, no thinking. Used by the QA judges in checks.py.

    Separate from translate_page because a judge takes no image and must not run at effort=max:
    it is scoring, not writing, and the whole point is that it stays cheap enough to run over
    every page of every book.
    """
    provider, vertex_id = MODELS[model_id]
    last = None
    for attempt in range(MAX_RETRIES):
        try:
            if provider == "anthropic":
                with _anthropic().messages.stream(
                        model=vertex_id, max_tokens=max_tokens,
                        system=[{"type": "text", "text": system}],
                        messages=[{"role": "user", "content": [{"type": "text", "text": user}]}]) as st:
                    for _ in st:
                        pass
                    m = st.get_final_message()
                return "".join(b.text for b in m.content if getattr(b, "type", None) == "text")
            from google.genai import types
            r = _gemini().models.generate_content(
                model=vertex_id, contents=user,
                config=types.GenerateContentConfig(system_instruction=system, temperature=0,
                                                   max_output_tokens=max_tokens))
            return r.text or ""
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

    def claim_after(i):
        j = next((k for k in assistant_idx if k > i and k not in claimed), None)
        if j is not None:
            claimed.add(j)
        return msgs[j][0] if j is not None else None

    # PHOTOS CLAIM FIRST. They are the spine, and pass 2 overwrites whatever they claim. Letting a
    # typed turn claim first lets it take a doc that pass 2 then re-creates, which stranded two v1
    # page translations under corrections in 好孩子好习惯（成长卷）.
    pages = []
    page = 0
    for i, (snap, d) in enumerate(msgs):
        if d.get("role") == "user" and d.get("image"):
            page += 1
            pages.append((page, snap, d, claim_after(i)))

    text_turns = [(snap, claim_after(i)) for i, (snap, d) in enumerate(msgs)
                  if d.get("role") == "user" and not d.get("image")]

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
                a_snap.reference.update({"replyTo": u_snap.id,
                                         "pageIndex": firestore.DELETE_FIELD})

    # --- pass 1: read the whole book, then decide the repeated wording once -------------------
    page_imgs = {}
    for page, u_snap, u_data, a_snap in pages:
        page_imgs[page] = (fetch_image(u_data["image"]["url"], img_cache),
                           u_data["image"].get("type", "image/jpeg"))
    page_texts = {}
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(ocr_page, img, mime): p for p, (img, mime) in page_imgs.items()}
        for f in cf.as_completed(futs):
            try:
                page_texts[futs[f]] = f.result()
            except Exception as e:  # noqa: BLE001
                log(f"  [{chat_id[:10]}] OCR failed on page {futs[f]}: {str(e)[:60]}")
                page_texts[futs[f]] = ""
    palette = vivid_palette(log=lambda m: log(f"  [{chat_id[:10]}]{m}"))
    slog = lambda m: log(f"  [{chat_id[:10]}]{m}")   # noqa: E731
    sheet = build_book_sheet(model_id, title, page_texts, palette, log=slog)
    unreadable = unreadable_terms(sheet)
    if unreadable:
        names = ", ".join(f"{i.get('yue','')} ({m})" for i, m in unreadable)
        slog(f"  sheet uses characters the Visual Font has no glyph for: {names} — asking again")
        sheet = build_book_sheet(
            model_id, title, page_texts, palette, log=slog,
            extra=("A previous attempt used these renderings, which contain characters the "
                   f"reader's font has no glyph for, so they lose their jyutping: {names}. "
                   "Choose different wording built from characters the font covers."))
        still = unreadable_terms(sheet)
        if still:
            slog(f"  still unreadable after retry: {[i.get('yue') for i, _ in still]}")
    addendum = sheet_block(sheet, palette)
    system = system + addendum
    stats["sheet_terms"] = len(sheet.get("terms", [])) if sheet else 0
    stats["sheet_refrains"] = len(sheet.get("refrains", [])) if sheet else 0
    stats["_sheet"] = sheet
    stats["_page_texts"] = page_texts

    # --- pass 2: translate each page, pinned by the sheet -------------------------------------
    translations = {}
    history = []
    for page, u_snap, u_data, a_snap in pages:
        try:
            img, mime = page_imgs[page]
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
        translations[page] = text

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

    # Did the fixed wording actually hold? This is the check the first rebuild did not have, and
    # its absence is why a term drifting at page 19 shipped looking clean.
    stats["drift"] = check_refrains(sheet, translations, page_texts, log=lambda m: log(f"  [{chat_id[:10]}]{m}"))

    if apply:
        chat_ref.update({"systemPrompt": tpl["systemPrompt"],
                         "enableWebSearch": bool(tpl.get("enableWebSearch")),
                         "rebuiltAt": firestore.SERVER_TIMESTAMP, "rebuiltModel": model_id,
                         "bookSheet": sheet or None})
        stats["verify"] = verify_chat(chat_ref)
        log(f"[{chat_id[:10]}] verify: {stats['verify']}")

    log(f"[{chat_id[:10]}] DONE rebuilt={stats['rebuilt']} created={stats['created']} "
        f"deleted={stats['deleted']} errors={stats['errors']}")
    if stats["corrected_pages"]:
        log(f"[{chat_id[:10]}] pages followed by a conversation turn (usually a correction you "
            f"asked for — the fresh translation will not know about it): {stats['corrected_pages']}")
    return stats


def check_refrains(sheet, translations, page_texts, log=print):
    """Wherever the SOURCE carries a fixed phrase, the translation must carry its fixed rendering.

    This is the check the first rebuild did not have, and its absence is why a term drifting at
    page 19 shipped looking clean: the LLM judge only ever saw one page at a time, so a word that
    changed halfway through the book was invisible to it. Grumpy Monkey ran 燥底 on pages 4-9 and
    扭擰 on 19-25 and still scored 4.44.

    Renderings may be templates with ___ for the slot that changes; every literal fragment around
    the slot has to be present.
    """
    if not sheet:
        return []

    def present(rendering, text):
        r = rendering
        for mark in ("___", "…", "...", "／", "/", "[", "]", "（", "）", "(", ")"):
            r = r.replace(mark, "\x00")
        parts = [f.strip() for f in r.split("\x00") if len(f.strip()) >= 2]
        return all(f in text for f in parts) if parts else False

    problems = []
    for kind in ("terms", "refrains"):
        for item in sheet.get(kind, []):
            src = (item.get("source") or "").strip()
            fixed = (item.get("yue") or "").strip()
            if not src or not fixed or len(fixed) < 2:
                continue
            # Short generic words produce noise, not signal: 'rain' fires on a page that says
            # 雨停咗喇 because the sheet fixed the noun 落雨, and 'sun' fires on 'sunshine'. The
            # failure this guards against is a multi-word running phrase changing halfway through
            # a book, which is always well over this length.
            key = src.split("/")[0].split("[")[0].strip().lower()
            if len(key) < 5:
                continue
            expected = sorted(p for p, t in page_texts.items() if key in (t or "").lower())
            missing = [p for p in expected if not present(fixed, translations.get(p, ""))]
            if expected and missing:
                problems.append({"kind": kind, "source": src, "yue": fixed,
                                 "on_pages": expected, "missing_on": missing})
                log(f"  DRIFT {kind}: {src!r} -> {fixed!r} expected on {expected}, "
                    f"missing on {missing}")
    if not problems:
        log("  refrain check: every fixed rendering held on every page that needed it")
    return problems


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
