# MpBuddy — Competitive Gap Report & Roadmap (Oct 2026)

## 1. Where MpBuddy is today

- Privacy-first, 100% in-browser media tools powered by ffmpeg.wasm (MT core via COOP/COEP).
- PWA: installable, offline after first run, ffmpeg core runtime-cached.
- Current tools: **Compress, Trim (keep range / remove sections), Extract MP3, Convert (MP4/WebM/MP3/GIF), Crop to ratio, Thumbnail export**.
- One file at a time, no image support, no audio-focused tools, no multi-step pipelines (each run re-starts from scratch).

Positioning is strong (private, no account, no watermark, offline) — but the tool catalog is thin versus what the market now expects for a "media toolbox".

## 2. Competitive scan

### Direct privacy-first ffmpeg.wasm competitors

| Product | What they ship that we don't (yet) |
|---|---|
| **FFmpegLab** | 30+ built-in ops: rotate/flip, speed up/slow down, merge/concat, xfade transitions, audio mixing (amix), extract audio, mute section, loop/boomerang, stills→slideshow (zoompan), subtitles/burn-in, drawtext captions, FPS change, stabilize (vidstab/deshake), denoise (hqdn3d/nlmeans), color correction, mosaic/xstack, fade in/out, watermark, scene detection templates, GIF guide, Pexels stock inside editor, YAML/SQL pipeline API |
| **Localsquash** | Trim + crop + scale + compress; 70–95% reduction claims; per-CRF control |
| **ffmpeg-webCLI** | "Trim applies on top of every op" (multi-step pipeline!), resize, GIF, captioning, PiP, concatenate, offline PWA |
| **ffmpeg.wasm tools (personal)** | Video from images, poster image, editable ffmpeg command preview |
| **ezgif (cloud, but the GIF reference)** | GIF optimize/reduce weight, effects frames, resize, reverse; huge GIF-specific feature surface |
| **Squoosh (cloud/app reference for images)** | Image compress compare slider, WebP/AVIF/MozJPEG, resize, rotate; offline PWA |
| **image0.dev** | Set of small local image utilities |
| **NoUploadTools pattern** | A growing directory of "your files stay local" utilities — the whole market is trending no-upload |

### Adjacent incumbents (why users pay/install elsewhere)

- **Clipchamp / VEED / CapCut**: browser-based, big UX budgets, but cloud-heavy, watermarks on free tiers, uploads your files.
- **8+ competing "54 privacy-first web tools" makers** — validation that private local tools are a real, popular niche (r/indiebiz, r/SideProject posts regularly go viral).

### What the market is asking for (demand signals)

1. **Privacy / no upload / no account / no watermark** — already our wedge. Keep front and center.
2. **Mobile-friendly web editor** — FFmpegLab's mobile web editor article is literally marketed for phones; PWA + responsive UI is table stakes.
3. **Shorts/social prep** — vertical crop, 9:16 pad, target size for Discord/WhatsApp limits (already partially covered — promote it).
4. **Image tools** — compression to WebP/AVIF, resize, format conversion. Missing entirely for us. Squoosh is the reference.
5. **Audio work** — extract, trim, fade, normalize loudness, mute/replace, merge songs. Only MP3 extraction exists today.
6. **Captions/transcripts** — Whisper-in-browser is the #1 "wow" feature trend (local Whisper via transformers.js/onnxruntime-web). Subtitle burn-in is ffmpeg-trivial once you have SRT.
7. **Speed + silence removal** — 1x/1.5x/2x speedups and silence-stripping for podcasts/screencasts.
8. **Rotate/flip** — trivially requested for phone landscape/vertical mixups.
9. **Batch / multi-file** — the classic complaint about single-file tools.
10. **Before/after comparison UX** — Squoosh's slider is best-in-class; a preview compare for compress/crop/convert is a big perceived-quality win.
11. **Progress with ETA + resumable files** — big production files feel scary without ETA.

## 3. Feature gap — what to add (prioritized)

### Tier 1 — High value, low risk (pure ffmpeg args, fits existing `ToolDef` pattern)

1. **Rotate & flip** (`transpose`, `hflip/vflip`) — phone-video fixer, everyone searches it.
2. **Speed** (`setpts` + `atempo`) — 0.5x–4x, keep audio in sync; "1.5x podcast" preset.
3. **Volume & normalize** (`volume`, `loudnorm`) — podcast-friendly.
4. **Mute / strip audio** (`-an`) — one tap, cross-referenced with Trim.
5. **Fade in/out** (`fade`, `afade`).
6. **Merge/concat** multiple videos (drop-multi-file, concat filter).
7. **Loop / boomerang** (`-stream_loop`, reverse).
8. **Reverse** (`reverse` + `areverse`) — fun GIF-adjacent.
9. **Frame rate / resize** as standalone (we have scale inside compress only).
10. **Grayscale/sepia/brightness/contrast** (`eq`, `hue`, `colorchannelmixer`) — "filter" tool.

### Tier 2 — Market differentiators

11. **Image tools** — compress/convert (PNG/JPG/WebP/AVIF via ffmpeg), resize, grayscale; a small "images" section like Squoosh. This opens the door to EVERY image search query.
12. **GIF tool upgrade** — ffmpeg palette GIF exists; add "reduce size/optimize GIF", GIF→MP4, MP4→optimized GIF with fps/quality sliders (ezgif parity-lite).
13. **Subtitles** — upload SRT → burn in (`subtitles` filter). Pair with:
14. **Local transcription** — Whisper via onnxruntime-web/transformers.js, export SRT/TXT + burn-in. This is the trendiest feature in 2026 browser tools; privacy story is perfect ("your voice never leaves the device").
15. **Watermark/text** — drawtext overlay (name/logo), position + opacity.
16. **Slideshow / images→video** (`concat`/`zoompan`) + poster frame (we have thumbnail; extend to contact sheet).

### Tier 3 — UX bets that beat everyone on feel

- **Compare slider** on Compress/Convert output (Squoosh-style before/after).
- **Estimated output size** before running (fast probe heuristic, show "~8 MB").
- **Queue/batch** — drop 20 files, run Compress on all.
- **Recent runs list** (name, tool, when) stored in localStorage/OPFS.
- **Share-target PWA** (`share_target` in manifest) — "share from Photos app → MpBuddy".
- **Thumbnail-strip timeline for trim** (already have TrimEditor — make it visible everywhere; consider waveform for audio).
- **Keyboard shortcuts** (Space to preview, Enter to run).
- **ETA + throughput** on progress bar.

## 4. Recommended next build (what the follow-up session should do)

1. Add **Tier-1 tools** into `src/tools.ts` + tabs (rotate, speed, volume/mute, fade, merge, loop/boomerang, reverse, resize, filter, extract frames).
2. Add an **Images** tab (compress, resize, convert between PNG/JPG/WebP).
3. Upgrade **Convert** to target-size picker shared with images.
4. Add **compare preview** for compress and crop.
5. Wire **batch queue** (multi-file drop → same tool) — biggest "beats it" move.
6. Keep everything static-PWA + privacy (no servers); document headers for host.

Order matters: Tier-1 tools first (biggest surface-area win per LOC), then images, then batch/compare UX.

## 5. Sources consulted

- FFmpegLab (ffmpeglab.com) — feature grid & mobile-web-editor positioning
- Localsquash.com — browser compressor positioning
- ffmpeg-webCLI (GitHub/HN) — pipeline-trim-first UX, offline PWA
- Squoosh.app — image compressor UX reference
- Ezgif — GIF tool surface (reference leader)
- Reddit: r/indiebiz "54 privacy-first web tools", r/SideProject image0.dev, r/webdev NoUploadTools, r/VideoEditing browser editors
- ffmpeglab.com template guides: rotate, speed, merge, watermark, subtitles, noise, denoise, stabilize, reverse, loop, fps, frames
