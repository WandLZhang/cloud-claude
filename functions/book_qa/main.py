"""book_qa — nightly finalize + QA review for the book-translation chats.

Cloud Scheduler hits this once a night (private; OIDC as the compute SA, same pattern as
chinese-convo-live's convo_live_ingest_google). It does two version-gated phases:

  A. FINALIZE  A book photographed through the app is translated with full history, so terminology
     holds by inertia — but on page 4 the model has not seen page 19 and cannot choose the running
     word deliberately. This re-runs the two-pass pipeline: read the whole book, write a book sheet
     fixing the repeated wording, then translate every page pinned to it.

  B. REVIEW    Four checks over the finalized book. A page that has drifted off its own photo is
     re-translated and flagged; book-level judgements are reported, never auto-fixed.

Both phases select ONLY work that has not been done at the current version. A normal night selects
nothing and returns in seconds. Bumping PIPELINE_VERSION or QA_VERSION is how a prompt, model or
rubric change is rolled out, and the corpus converges over however many nights it needs.

POST body (all optional): {"dryRun": true, "onlyChat": "<id>", "force": true, "budgetSeconds": n}
"""
import datetime
import os
import pathlib
import time
import traceback

import functions_framework
from flask import jsonify
from google.cloud import firestore

import checks
import pipeline

# The corpus always lives in wz-cloud-claude, so the constant is the source of truth and only an
# explicit PROJECT_ID overrides it. Deliberately NOT reading GOOGLE_CLOUD_PROJECT or the ADC
# project: both are the caller's ambient project, and on this workstation they point at an
# unrelated one, which silently aimed a local run at the wrong database.
PROJECT = os.getenv("PROJECT_ID") or pipeline.PROJECT_ID
USER_ID = os.getenv("BOOK_QA_USER_ID", pipeline.USER_ID)

# Bump to re-translate every book on the next run. Change this when the sheet prompt, the page
# instruction, the history window or the model changes.
PIPELINE_VERSION = 1
# Bump to re-review every book without re-translating. Change this when a check or rubric changes.
QA_VERSION = 2

MIN_PAGES = 3                  # fewer than this is not a book yet
QUIESCE_HOURS = 6              # never finalize a book that is still being photographed
DEFAULT_BUDGET_S = 45 * 60     # the function ceiling is 3600s; stop cleanly well before it
MAX_REPAIRS_PER_BOOK = 20      # past this it is systemic — report it, do not rewrite the book
# A book left with an error is retried the next night rather than parked silently. After this many
# nights it IS parked: 好孩子好习惯 - 心灵卷 sat at fidelity 3 on the same three pages for 14
# consecutive nights, re-reviewed every time, because a re-translation cannot fix a defect the
# judge keeps scoring the same way. Retrying forever is not persistence, it is noise.
MAX_QA_STRIKES = 3

db = firestore.Client(project=PROJECT)


def _conversations():
    return db.collection("chats").document(USER_ID).collection("conversations")


def _load_templates():
    out = {}
    for tid in pipeline.BOOK_TEMPLATES:
        d = (db.collection("prompts").document(USER_ID)
             .collection("userPrompts").document(tid).get().to_dict())
        if not d or not d.get("systemPrompt"):
            raise RuntimeError(f"prompt template {tid} missing or has no systemPrompt")
        out[tid] = d
    return out


def survey(only_chat=None):
    """Every book chat, with what each one still needs. One pass over Firestore."""
    now = datetime.datetime.now(datetime.timezone.utc)
    books = []
    docs = ([_conversations().document(only_chat).get()] if only_chat
            else list(_conversations().stream()))
    for snap in docs:
        d = snap.to_dict() or {}
        if not d:
            continue
        # Only three fields per message. Pulling full `content` for all 76 conversations every
        # night would read megabytes to answer a question about counts and timestamps.
        msgs = [(m.id, m.to_dict() or {}) for m in
                snap.reference.collection("messages")
                .select(["role", "image", "timestamp", "content"])
                .order_by("timestamp").stream()]
        photos = [(mid, x) for mid, x in msgs if x.get("role") == "user" and x.get("image")]
        if len(photos) < MIN_PAGES:
            continue
        first_user = next((x.get("content", "") for _, x in msgs if x.get("role") == "user"), "")
        tid = pipeline.detect_template(d, first_user)
        # detect_template always returns a template, so require a real book system prompt or a
        # sheet from a previous run before treating a chat as a book.
        sp = d.get("systemPrompt") or ""
        looks_like_book = pipeline.is_book_prompt(sp) or bool(d.get("bookSheet"))
        if not looks_like_book:
            continue

        newest = max((x.get("timestamp") for _, x in msgs if x.get("timestamp")), default=None)
        quiet = newest is None or (now - newest).total_seconds() > QUIESCE_HOURS * 3600
        fin, qa = d.get("finalize") or {}, d.get("qa") or {}
        books.append({
            "id": snap.id, "title": d.get("title", ""), "templateId": tid,
            "pages": len(photos), "quiet": quiet,
            "needsFinalize": (fin.get("version", 0) < PIPELINE_VERSION
                              or fin.get("pageCount") != len(photos)),
            # a re-translation invalidates the previous review; an unresolved one is retried
            # only until it has used up its strikes
            "needsReview": (qa.get("version", 0) < QA_VERSION
                            or qa.get("finalizeVersion") != fin.get("version")
                            or (bool(qa.get("needsAttention"))
                                and qa.get("strikes", 0) < MAX_QA_STRIKES)),
        })
    return books


def backfill_finalize(dry_run, log):
    """Stamp `finalize` on books already rebuilt at this pipeline by hand.

    Without this the very first nightly run sees no `finalize` record anywhere and re-translates
    all 529 pages that were just rebuilt. A book counts as already finalized if it carries a
    `bookSheet` (only the two-pass pipeline writes one) and was rebuilt by the current model.
    `qa` is deliberately left unset, so every book is still reviewed — the review is the cheap half
    and it has never actually run.
    """
    done = []
    for b in survey():
        ref = _conversations().document(b["id"])
        d = ref.get().to_dict() or {}
        if not d.get("bookSheet") or d.get("rebuiltModel") != pipeline.DEFAULT_MODEL:
            continue
        rec = {"version": PIPELINE_VERSION, "at": d.get("rebuiltAt") or firestore.SERVER_TIMESTAMP,
               "model": d.get("rebuiltModel"), "pageCount": b["pages"],
               "sheetTerms": len((d["bookSheet"] or {}).get("terms") or []),
               "sheetRefrains": len((d["bookSheet"] or {}).get("refrains") or []),
               "status": "ok", "backfilled": True}
        if not dry_run:
            ref.update({"finalize": rec})
        done.append({"chatId": b["id"], "title": b["title"], "pages": b["pages"]})
        log(f"backfilled finalize v{PIPELINE_VERSION}: {b['id'][:10]} '{b['title']}' ({b['pages']}p)")
    return done


def review_book(chat_id, title, dry_run, log):
    """Phase B over one finalized book. Returns (record, findings)."""
    ref = _conversations().document(chat_id)
    chat = ref.get().to_dict() or {}
    msgs = [(m.id, m.to_dict() or {}) for m in
            ref.collection("messages").order_by("timestamp").stream()]

    findings = checks.structure_markup(chat_id, msgs, pipeline.font_codepoints())

    page_docs = {x["pageIndex"]: (mid, x) for mid, x in msgs if x.get("pageIndex")}
    pages = {p: x.get("content", "") for p, (_, x) in page_docs.items()}
    if not pages:
        return {"status": "no pages"}, findings

    findings += checks.register_drift(chat_id, pages)

    photo_of = {mid: x for mid, x in msgs if x.get("role") == "user" and x.get("image")}
    img_cache, page_imgs = {}, {}
    for p, (_, x) in page_docs.items():
        ph = photo_of.get(x.get("replyTo"))
        if ph:
            page_imgs[p] = (pipeline.fetch_image(ph["image"]["url"], img_cache),
                            ph["image"].get("type", "image/jpeg"))

    # Every book finalized before the transcription was kept has no sourceText. OCR those pages
    # once, here, and store it — cheaper than re-finalizing the corpus, and it converges.
    source_texts = {p: (x.get("sourceText") or "") for p, (_, x) in page_docs.items()}
    missing = [p for p, t in source_texts.items() if not t.strip() and p in page_imgs]
    if missing:
        log(f"  transcribing {len(missing)} page(s) that predate sourceText")
        import concurrent.futures as _cf
        with _cf.ThreadPoolExecutor(max_workers=6) as ex:
            futs = {ex.submit(pipeline.ocr_page, *page_imgs[p]): p for p in missing}
            for f in _cf.as_completed(futs):
                p = futs[f]
                try:
                    source_texts[p] = f.result()
                except Exception as e:  # noqa: BLE001
                    log(f"  OCR failed on p{p}: {str(e)[:60]}")
                    continue
                if not dry_run:
                    ref.collection("messages").document(page_docs[p][0]).update(
                        {"sourceText": source_texts[p]})

    fid_findings, scores = checks.page_fidelity(chat_id, page_imgs, pages,
                                                source_texts=source_texts)
    findings += fid_findings

    # Repair the pages that drifted off their own photo, pinned to the book's stored sheet.
    bad = sorted(p for p, s in scores.items() if s < 4)
    repaired, needs_attention = [], False
    if len(bad) > MAX_REPAIRS_PER_BOOK:
        needs_attention = True
        log(f"  {len(bad)} pages below 4 — systemic, not repairing; flagged for attention")
    elif bad and not dry_run:
        tpl = _load_templates()[pipeline.detect_template(chat, "")]
        system = tpl["systemPrompt"] + pipeline.sheet_block(chat.get("bookSheet"),
                                                            pipeline.vivid_palette(log=lambda _m: None))
        instruction = f"{tpl['content']}\n\n{pipeline.PAGE_INSTRUCTION}"
        # What the judge actually said about each bad page, so the repair is a correction rather
        # than a blind re-roll of the same dice.
        why = {f.get("page"): f.get("detail", "") for f in fid_findings if f.get("page")}
        for p in bad:
            mid, doc = page_docs[p]
            img, mime = page_imgs[p]
            try:
                fresh = pipeline.repair_page(pipeline.DEFAULT_MODEL, system, instruction, img, mime,
                                             why.get(p, ""), source_texts.get(p, ""),
                                             doc.get("content", ""))
            except Exception as e:  # noqa: BLE001
                log(f"  p{p} repair failed: {str(e)[:70]}")
                continue
            if fresh is None:
                # The reviewer was wrong about this page — three of five flags on 心灵卷 were.
                # Rewriting a correct page to satisfy a bad complaint is worse than leaving it.
                log(f"  p{p} complaint did not hold up against the page — left unchanged")
                repaired.append({"page": p, "before": scores[p], "after": scores[p],
                                 "declined": True})
                continue
            payload = {"content": fresh, "repairedAt": firestore.SERVER_TIMESTAMP}
            if "contentBeforeRebuild" not in doc:
                payload["contentBeforeRebuild"] = doc.get("content", "")
            ref.collection("messages").document(mid).update(payload)
            pages[p] = fresh
            _, after = checks.page_fidelity(chat_id, {p: page_imgs[p]}, {p: fresh})
            new_score = after.get(p)
            before = scores[p]                      # capture BEFORE overwriting, or the report
            scores[p] = new_score if new_score is not None else before   # says "4 -> 4"
            repaired.append({"page": p, "before": before, "after": new_score})
            log(f"  p{p} repaired: fidelity {before} -> {new_score}")
            if new_score is not None and new_score < 4:
                needs_attention = True

    # A page that was repaired back above the bar is no longer a finding — leaving the original
    # error in would mark the book needsAttention forever and hide what is actually still wrong.
    # A page the repair declined is treated as resolved: the judge's complaint was examined
    # against the photo and the transcription and rejected. Otherwise a false positive would keep
    # the book in needsAttention until it burned all three strikes.
    # A page counts as resolved either because the repair raised it, or because the repair looked
    # at the complaint against the photo and the transcription and rejected it. Both are outcomes;
    # only a page that stays low WITHOUT being declined keeps the book flagged (needs_attention,
    # set in the loop above).
    fixed = {r["page"] for r in repaired if (r["after"] or 0) >= 4 or r.get("declined")}
    if fixed:
        findings = [f for f in findings
                    if not (f["check"] == "fidelity" and f.get("page") in fixed)]
        findings.append({"check": "fidelity", "severity": "info", "chatId": chat_id,
                         "detail": "; ".join(
                             (f"p{r['page']} complaint rejected on review (stayed {r['before']})"
                              if r.get("declined")
                              else f"p{r['page']} repaired {r['before']}->{r['after']}")
                             for r in repaired if r["page"] in fixed)})

    rt_findings, overall = checks.book_readthrough(chat_id, title, pages, checks.JUDGE_MODEL)
    findings += rt_findings

    prior = (chat.get("qa") or {})
    strikes = (prior.get("strikes", 0) + 1) if prior.get("needsAttention") else 0

    record = {
        "version": QA_VERSION,
        "strikes": strikes,
        "finalizeVersion": (chat.get("finalize") or {}).get("version"),
        "at": firestore.SERVER_TIMESTAMP,
        "pagesChecked": len(scores),
        "pagesRepaired": len(repaired),
        "fidelityMean": checks.mean(list(scores.values())),
        "readthrough": overall,
        "findings": findings[:40],
        "needsAttention": needs_attention or any(f["severity"] == "error" for f in findings),
    }
    # An unresolved book comes back tomorrow — but only while it has strikes left. Once they are
    # spent it is stamped at the current version and marked `parked`, so it stops consuming a
    # review every night and simply waits for a human.
    record["parked"] = record["needsAttention"] and strikes >= MAX_QA_STRIKES
    if not dry_run:
        ref.update({"qa": record if (not record["needsAttention"] or record["parked"])
                    else {**record, "version": 0}})
        if record["parked"]:
            log(f"  parked after {strikes} nights unresolved — needs a human, not another retry")
    return record, findings


@functions_framework.http
def book_qa(request):
    body = request.get_json(silent=True) or {}
    dry_run = bool(body.get("dryRun"))
    do_backfill = bool(body.get("backfill"))
    only_chat = body.get("onlyChat")
    force = bool(body.get("force"))
    deadline = time.monotonic() + int(body.get("budgetSeconds") or DEFAULT_BUDGET_S)
    started = datetime.datetime.now(datetime.timezone.utc)
    lines = []

    def log(m):
        print(m)
        lines.append(m)

    report = {"startedAt": started, "pipelineVersion": PIPELINE_VERSION, "qaVersion": QA_VERSION,
              "dryRun": dry_run, "finalized": [], "reviewed": [], "findings": [],
              "truncated": False, "errors": []}
    try:
        if do_backfill:
            report["backfilled"] = backfill_finalize(dry_run, log)
        books = survey(only_chat)
        todo_f = [b for b in books if (force or b["needsFinalize"]) and b["quiet"]]
        todo_r = [b for b in books if force or b["needsReview"]]
        report["selected"] = {"books": len(books), "toFinalize": len(todo_f), "toReview": len(todo_r)}
        log(f"survey: {len(books)} book chats, {len(todo_f)} to finalize, {len(todo_r)} to review")
        skipped = [b["id"] for b in books if b["needsFinalize"] and not b["quiet"]]
        if skipped:
            log(f"still being photographed, left alone: {skipped}")

        if todo_f:
            templates = _load_templates()
            backup_dir = pathlib.Path("/tmp") / "book_qa_backups" / started.strftime("%Y%m%d-%H%M%S")
            for b in todo_f:
                if time.monotonic() > deadline:
                    report["truncated"] = True
                    break
                log(f"finalize {b['id'][:10]} '{b['title']}' ({b['pages']} pages)")
                st = pipeline.process_chat(db, b["id"], templates, pipeline.DEFAULT_MODEL,
                                           backup_dir, not dry_run, {}, log=log)
                if not dry_run and not st.get("skipped"):
                    _conversations().document(b["id"]).update({"finalize": {
                        "version": PIPELINE_VERSION, "at": firestore.SERVER_TIMESTAMP,
                        "model": pipeline.DEFAULT_MODEL, "pageCount": b["pages"],
                        "sheetTerms": st.get("sheet_terms", 0),
                        "sheetRefrains": st.get("sheet_refrains", 0),
                        "drift": len(st.get("drift") or []),
                        "status": "ok" if not st.get("errors") else "errors"}})
                report["finalized"].append({"chatId": b["id"], "title": b["title"],
                                            "pages": st.get("pages"), "errors": st.get("errors"),
                                            "sheetTerms": st.get("sheet_terms")})

        for b in todo_r:
            if time.monotonic() > deadline:
                report["truncated"] = True
                break
            log(f"review {b['id'][:10]} '{b['title']}'")
            try:
                rec, found = review_book(b["id"], b["title"], dry_run, log)
            except Exception as e:  # noqa: BLE001
                log(f"  review failed: {type(e).__name__}: {e}")
                report["errors"].append({"chatId": b["id"], "error": f"{type(e).__name__}: {e}"})
                continue
            report["reviewed"].append({"chatId": b["id"], "title": b["title"],
                                       "pagesChecked": rec.get("pagesChecked"),
                                       "pagesRepaired": rec.get("pagesRepaired"),
                                       "fidelityMean": rec.get("fidelityMean"),
                                       "readthrough": rec.get("readthrough"),
                                       "needsAttention": rec.get("needsAttention")})
            report["findings"] += found[:40]

        report["summary"] = checks.summarise(report["findings"])
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        report["errors"].append({"fatal": f"{type(e).__name__}: {e}"})

    report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc)
    report["log"] = lines[-400:]
    if not dry_run:
        # A run that selected nothing still writes, so silence is distinguishable from a job that
        # never fired.
        (db.collection("chats").document(USER_ID).collection("qaReports")
         .document(started.strftime("%Y-%m-%d")).set(report))
    return jsonify({k: v for k, v in report.items() if k != "log"}), 200
