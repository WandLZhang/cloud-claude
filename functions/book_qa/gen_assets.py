"""Regenerate the two committed assets book_qa needs at runtime. Ops only — never deployed.

The function must not carry either source: the Visual Font is 16.6 MB, and the Words.hk corpus
lives in a different project (wz-data-catalog-demo) that a nightly Firestore job has no business
holding credentials for. Both are resolved here, offline, and the small results are committed.

    vf_canto_cmap.json  every codepoint public/fonts/VF-Canto-HKEdB.woff2 can draw, as ranges.
                        A character outside it silently loses its jyutping in the app, because the
                        browser falls back to a system face.
    palette.json        the ABB/AAB and onomatopoeic seed forms that Words.hk actually attests,
                        with their gloss. Grounds the vividness instruction, which was previously
                        asserted in the prompt and in the benchmark rubric and checked in neither.

Usage:
    source .venv/bin/activate
    python functions/book_qa/gen_assets.py            # both
    python functions/book_qa/gen_assets.py --cmap     # just the font ranges (no Vertex calls)
"""
import argparse
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
REPO = HERE.parent.parent
FONT = REPO / "public" / "fonts" / "VF-Canto-HKEdB.woff2"
RAG_ENGINE = REPO.parent / "language-benchmarks" / "engine"


def gen_cmap():
    from fontTools.ttLib import TTFont
    cps = set()
    for t in TTFont(str(FONT))["cmap"].tables:
        cps |= set(t.cmap)
    ranges, lo, prev = [], None, None
    for cp in sorted(cps):
        if lo is None:
            lo = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            ranges.append([lo, prev])
            lo = prev = cp
    if lo is not None:
        ranges.append([lo, prev])
    out = {"_source": FONT.name, "codepoints": len(cps), "ranges": ranges}
    path = HERE / "vf_canto_cmap.json"
    path.write_text(json.dumps(out))
    print(f"{path.name}: {len(cps)} codepoints in {len(ranges)} ranges, {path.stat().st_size // 1024} KB")
    for ch in "䒐䒏嫲嬲扭計靚":
        print(f"   {ch} U+{ord(ch):04X} {'yes' if ord(ch) in cps else 'NO'}")


def gen_palette():
    sys.path.insert(0, str(RAG_ENGINE))
    import rag  # noqa: PLC0415

    sys.path.insert(0, str(HERE))
    import pipeline  # noqa: PLC0415

    out = []
    for w in pipeline.PALETTE_SEEDS:
        try:
            hits = rag.retrieve(w, k=1)
        except Exception as e:  # noqa: BLE001
            print(f"   {w}: retrieval failed ({str(e)[:50]})")
            continue
        if not hits or not hits[0].startswith(tuple("0123456789")):
            continue
        head = hits[0].split(",", 1)[1] if "," in hits[0] else hits[0]
        if not head.startswith(w):        # retriever drifted to a different headword; drop it
            continue
        gloss = ""
        if "eng:" in head:
            # The corpus row continues past the definition with review metadata
            # (…dumb",,OK,未公開). Cut at the closing quote before anything else.
            gloss = head.split("eng:", 1)[1].split("<eg>")[0].split('"')[0].strip()[:60]
        out.append({"w": w, "gloss": gloss or "attested in Words.hk"})
    path = HERE / "palette.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"\n{path.name}: {len(out)} of {len(pipeline.PALETTE_SEEDS)} seeds attested")
    for e in out:
        print(f"   {e['w']} — {e['gloss']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cmap", action="store_true", help="font ranges only")
    ap.add_argument("--palette", action="store_true", help="Words.hk palette only")
    a = ap.parse_args()
    both = not (a.cmap or a.palette)
    if a.cmap or both:
        gen_cmap()
    if a.palette or both:
        gen_palette()
