"""The four QA checks run over a finalized book.

Every one of these exists because it caught a real defect that the thing before it could not see:

  structure_markup  the audit typed by hand after each rebuild — 13 photos with no reply, 7 replies
                    with no photo, 553 user messages against 547 assistant ones.
  register_drift    書面語 leaking into a Cantonese line, and one sentence-final particle taking
                    over a book. 吖嘛 went 1 -> 15 in a rebuild and scored well, because a per-page
                    judge cannot see a tic that only exists across pages.
  page_fidelity     a translation that drifted off its own page. 灰姑娘 doc [8] held a second copy
                    of page 4 while page 3's translation stopped existing.
  book_readthrough  does it still read as a book. The running word in Grumpy Monkey changed at page
                    19 and the page-by-page benchmark still scored it 4.44.

Findings are dicts: {check, severity, chatId, page?, detail}. severity is "error" (structurally
broken) or "warn" (a judgement call for a human).
"""
import concurrent.futures as cf
import json
import re
import statistics

import pipeline

STRIP_SPAN = re.compile(r"</?span[^>]*>")
OPEN_SPAN = re.compile(r'<span class="zh-(yue|cmn)">')
CLOSE_SPAN = re.compile(r"</span>")
# A jyutping syllable is latin letters + a tone digit. The prompts forbid romanization inside a
# span because the Visual Font draws it; if it leaks the reader sees it twice.
JYUTPING = re.compile(r"\b[a-z]{1,6}[1-6]\b")

# Markers of standard written Chinese. A Cantonese line built out of these is Mandarin in disguise
# — the exact failure the colloquial prompt is written to prevent.
WRITTEN_MARKERS = ["的", "是", "不", "沒有", "他", "她", "這", "那", "在", "和", "很", "了",
                   "什麼", "為什麼", "現在", "東西", "喜歡", "可以", "但是", "非常"]
# Sentence-final particles. One of these dominating a book is the 吖嘛 tic.
PARTICLES = ["吖嘛", "㗎喇", "嘅啫", "囉噃", "啦", "喇", "囉", "咩", "㗎", "喎", "噃", "呀", "吖", "嘞"]


def _yue(content):
    """The Cantonese half of a reply, tags stripped."""
    t = STRIP_SPAN.sub("", content or "")
    return t.split("**Cantonese:**")[-1] if "**Cantonese:**" in t else t


def structure_markup(chat_id, msgs, font_cps):
    """Deterministic, free. Runs over the message list as stored."""
    out = []
    photos = {mid for mid, d in msgs if d.get("role") == "user" and d.get("image")}
    replies = {}
    for mid, d in msgs:
        if d.get("role") == "assistant" and d.get("replyTo"):
            replies.setdefault(d["replyTo"], []).append(mid)

    for p in sorted(photos - set(replies)):
        out.append({"check": "structure", "severity": "error", "chatId": chat_id,
                    "detail": f"photo {p} has no reply"})
    for p, ids in replies.items():
        if p in photos and len(ids) > 1:
            out.append({"check": "structure", "severity": "error", "chatId": chat_id,
                        "detail": f"photo {p} has {len(ids)} replies"})

    for mid, d in msgs:
        if d.get("role") != "assistant":
            continue
        c = d.get("content") or ""
        page = d.get("pageIndex")
        if not d.get("replyTo"):
            out.append({"check": "structure", "severity": "warn", "chatId": chat_id, "page": page,
                        "detail": f"reply {mid} is not anchored to any message"})
        if page and d.get("replyTo") not in photos:
            out.append({"check": "structure", "severity": "error", "chatId": chat_id, "page": page,
                        "detail": f"reply {mid} carries pageIndex {page} but does not answer a photo"})
        if not c.strip():
            continue
        if len(OPEN_SPAN.findall(c)) != len(CLOSE_SPAN.findall(c)):
            out.append({"check": "markup", "severity": "error", "chatId": chat_id, "page": page,
                        "detail": "unbalanced <span> tags"})
        if JYUTPING.search(_yue(c)) and "<rt>" not in c:
            out.append({"check": "markup", "severity": "warn", "chatId": chat_id, "page": page,
                        "detail": "romanization leaked into a Cantonese line"})
        if font_cps:
            miss = {ch for ch in _yue(c) if ord(ch) > 0x2E80 and ord(ch) not in font_cps}
            if miss:
                out.append({"check": "markup", "severity": "warn", "chatId": chat_id, "page": page,
                            "detail": f"no Visual Font glyph for {''.join(sorted(miss))} "
                                      f"— those characters lose their jyutping"})
    return out


def register_drift(chat_id, pages, written_ratio=0.06, particle_share=0.55):
    """Deterministic, free. `pages` = {pageIndex: content}.

    Thresholds are deliberately loose: this flags a book for reading, it does not fail one.
    A handful of 的/在 is unremarkable in place names and set phrases; a steady stream is not.
    """
    out = []
    lines, chars, written = [], 0, 0
    for content in pages.values():
        y = _yue(content)
        chars += len(y)
        for m in WRITTEN_MARKERS:
            written += y.count(m)
        lines += [ln.strip() for ln in y.splitlines() if ln.strip()]
    if chars > 400:
        ratio = written / chars
        if ratio > written_ratio:
            out.append({"check": "register", "severity": "warn", "chatId": chat_id,
                        "detail": f"書面語 markers are {ratio:.1%} of the Cantonese text "
                                  f"({written} in {chars} chars) — reads as Mandarin in disguise"})
    counts = {}
    for ln in lines:
        for p in PARTICLES:                 # longest first: 吖嘛 before 吖
            if ln.rstrip("。！？」）…").endswith(p):
                counts[p] = counts.get(p, 0) + 1
                break
    total = sum(counts.values())
    if total >= 12:
        top, n = max(counts.items(), key=lambda kv: kv[1])
        if n / total > particle_share:
            out.append({"check": "register", "severity": "warn", "chatId": chat_id,
                        "detail": f"「{top}」ends {n} of {total} particle-final lines "
                                  f"({n/total:.0%}) — one shape is taking over the book"})
    return out


FIDELITY_RUBRIC = (
    "The attached photo is one page of a children's book. Below is the Cantonese translation "
    "stored for THIS page. Score 1-5 how faithfully it renders the text printed on this page:\n"
    "5 = every clause on the page is present, nothing invented, nothing dropped\n"
    "3 = one clause dropped or one detail invented\n"
    "1 = it is a different page, a continuation from memory, a summary, or empty.\n"
    "Ignore printed pinyin/jyutping guides; only the typeset source text counts. "
    'Return ONLY JSON: {"fidelity":n,"why":"<=15 words no quotation marks"}')

JUDGE_MODEL = "gemini-3.5-flash"     # cross-family from the claude-opus-5 generator


def page_fidelity(chat_id, page_imgs, pages, workers=6):
    """LLM, one call per page. Returns (findings, {page: score})."""
    from google.genai import types

    def one(page):
        img, mime = page_imgs[page]
        r = pipeline._gemini().models.generate_content(
            model=JUDGE_MODEL,
            contents=[types.Part.from_bytes(data=img, mime_type=mime),
                      types.Part.from_text(text=FIDELITY_RUBRIC + "\n\nStored translation:\n"
                                           + _yue(pages[page]))],
            config=types.GenerateContentConfig(temperature=0, max_output_tokens=2000))
        t = r.text or ""
        a, b = t.find("{"), t.rfind("}")
        j = json.loads(t[a:b + 1])
        return page, int(j["fidelity"]), str(j.get("why", ""))[:90]

    scores, out = {}, []
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(one, p): p for p in sorted(pages) if p in page_imgs}
        for f in cf.as_completed(futs):
            try:
                page, score, why = f.result()
            except Exception as e:  # noqa: BLE001
                out.append({"check": "fidelity", "severity": "warn", "chatId": chat_id,
                            "page": futs[f], "detail": f"judge failed: {str(e)[:70]}"})
                continue
            scores[page] = score
            if score < 4:
                out.append({"check": "fidelity", "severity": "error", "chatId": chat_id,
                            "page": page, "detail": f"fidelity {score}: {why}"})
    return out, scores


READTHROUGH_RUBRIC = """You are reading a whole children's picture book in Hong Kong Cantonese,
page by page, as a parent would read it aloud to a child.

Children's books work by repetition and rhythm. The same word, the same refrain and the same
sentence frame come back page after page, and that recurrence IS the effect. Judge the BOOK, not
the sentences — an individually fine page that breaks the pattern is a defect.

Character, place and brand names are deliberately left in the source language and read aloud in
English. That is a settled decision — never report it.

Report only real problems, at most six, each naming the page numbers:
- a word or phrase the source repeats that is rendered differently in different places
- a refrain whose frame changes when the source did not change
- register that slips: 書面語 creeping in, or an adult voice in a book for small children
- a shape used so often it becomes a tic
- a page that does not follow from the one before it

Also give one overall 1-5: would a Hong Kong parent enjoy reading this aloud, start to finish?

Return ONLY JSON, no quotation marks inside any value:
{"overall":n,"problems":[{"pages":[n],"issue":"<=25 words"}]}"""


def book_readthrough(chat_id, title, pages, model_id):
    """LLM, one call for the whole book. The metric the per-page benchmark was blind to."""
    body = "\n\n".join(f"PAGE {p}\n{_yue(c).strip()}" for p, c in sorted(pages.items()))
    raw = pipeline.judge_text(model_id, READTHROUGH_RUBRIC, f"Book: {title}\n\n{body}")
    a, b = raw.find("{"), raw.rfind("}")
    if a < 0:
        return [{"check": "readthrough", "severity": "warn", "chatId": chat_id,
                 "detail": f"judge returned no JSON: {raw[:80]}"}], None
    j = json.loads(raw[a:b + 1])
    out = []
    for p in (j.get("problems") or [])[:6]:
        out.append({"check": "readthrough", "severity": "warn", "chatId": chat_id,
                    "page": (p.get("pages") or [None])[0],
                    "detail": f"pages {p.get('pages')}: {p.get('issue', '')}"})
    return out, j.get("overall")


def summarise(findings):
    return {"total": len(findings),
            "errors": sum(1 for f in findings if f["severity"] == "error"),
            "repairs": sum(1 for f in findings if f["severity"] == "info"),
            "warnings": sum(1 for f in findings if f["severity"] == "warn"),
            "byCheck": {c: sum(1 for f in findings if f["check"] == c)
                        for c in sorted({f["check"] for f in findings})}}


def mean(xs):
    return round(statistics.mean(xs), 2) if xs else None
