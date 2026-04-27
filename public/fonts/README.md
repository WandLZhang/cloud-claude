# public/fonts/

## Required: `VF-Canto.ttf`

The CSS in `src/index.css` references `/fonts/VF-Canto.ttf` to render
coloured contextual jyutping above Cantonese characters in assistant messages
(everything wrapped in `<span class="zh-yue">…</span>`).

Until the file is in this directory:
- Cantonese spans render with the default system font (no jyutping above
  characters).
- The plain jyutping line below each Cantonese span stays visible as
  fallback — chats remain readable.
- Mandarin pinyin via inline `<ruby>` tags is unaffected (browser-native).

### To install the font

The font binary is gitignored (`*.ttf` under `public/fonts/`) so the repo
stays light. The source zip lives at `C:\Projects\cantonese-visual-fonts\`
(downloaded once from canto.hk shop / PASS).

1. Extract `community - hei regular 2.8 /fonts/color/VF-Canto.ttf`
   (~209 MB) from `community-hei-regular-2.8-.zip`.
2. Copy to `public/fonts/VF-Canto.ttf`.
3. Copy `Open Font License.md` from the same package to
   `public/fonts/OFL.md`.
4. Restart the dev server / redeploy. The browser fetches the font lazily
   only when a chat with `<span class="zh-yue">` is opened.

If 209 MB is too much for the deployed bundle, swap to one of the smaller
variants (update `src/index.css` `@font-face` URL + filename here):

- `community - hei regular 2.8 /fonts/monochrome/VF-Canto monochrome.ttf`
  (~35 MB, jyutping above chars but black-and-white)
- `community - hei regular 2.7/font - bw/VF-Canto.woff2`
  (~7 MB, smallest, B/W only, older v2.7)

### Font details

- Project: [canto.hk Visual Fonts](https://canto.hk/visual-fonts/) by Jon Chui
- Variant used: **Standard Pokfield** (`VF Cantonese.ttf`, ~210 MB,
  fixed-width 黑體 with color jyutping above chars)
- CSS font-family: `VF Cantonese`
- Format: TTF, OpenType-SVG color font with contextual ligatures
- Coverage: 29,138 Chinese characters with 39,480 jyutping readings
- Accuracy: 99.7% on Traditional Chinese
- License: SIL Open Font License (OFL) — redistribution allowed
- Browsers: Chrome, Edge, Safari, Firefox (modern versions support OT-SVG)
- Other variants in the same package (do NOT use for this app):
  - `VF-Canto-OnlyJyutping` — jyutping syllables only, no characters (Anki use)
  - `VF Canto - sans 黑體 - no jyutping.ttf` — chars without jyutping
  - `VF Canto - sans 黑體 - BW.ttf` — monochrome (~30 MB)
  - `VF Canto - sans 黑體 fluid.ttf` — variable width matching jyutping length
