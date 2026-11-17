# mpbuddy

Pocket media toolbox — private, in-browser media tools powered by [ffmpeg.wasm](https://ffmpegwasm.netlify.app/). Compress, trim, crop, convert, extract audio, and more. Files are processed entirely in your browser; nothing is uploaded.

## Features

Tools are grouped as "Shrink & share", "Cut & stitch", "Crop & style", "Sound", and "Stills":

- **Video:** compress, trim, convert, crop, resize, rotate, flip, merge, loop, reverse, filter, speed, fade, watermark, frames, thumbnail, metadata
- **Audio:** mp3 extraction, trim/cut, mute, denoise, voice isolation, waveform generation
- **Images:** compress/convert, HEIC → JPG, passport photo sizing

Outputs download directly from the browser, and recent jobs are remembered locally (IndexedDB).

## Run locally

Requires [Node.js](https://nodejs.org/) (v18+ recommended) and `npm`.

```bash
# install dependencies
npm install

# start dev server (http://localhost:5173)
npm run dev
```

The dev server sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` headers, which ffmpeg.wasm's
multithreaded core needs (`SharedArrayBuffer`).

Build and preview the production bundle:

```bash
npm run build
npm run preview
```

## Deploying

The app is a static Vite build (`npm run build` → `dist/`). If you self-host,
serve `dist` with the same COOP/COEP headers shown in `vite.config.ts` so the
ffmpeg.wasm worker can initialize.

## Tech stack

React 19, TypeScript, Vite, Tailwind CSS, ffmpeg.wasm, PWA (offline-capable).

## License

MIT