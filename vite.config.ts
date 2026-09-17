import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// COOP/COEP only matter for the multithreaded ffmpeg core (SharedArrayBuffer).
// Scoped here to dev/preview; apply the same two headers on your host.
const isolateHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// First paint: inline the built stylesheet and preload the Latin Inter subset.
// The app shell CSS is tiny (~24KB) and index.html already contains the
// static tab/options markup, so inlining removes the extra stylesheet
// round-trip that flashed unstyled content before main.ts hydrates.
function firstPaint(): Plugin {
  return {
    name: "first-paint-inline-css",
    enforce: "post",
    apply: "build",
    transformIndexHtml(html, ctx) {
      const bundle = ctx.bundle;
      if (!bundle) return html;
      let css = "";
      const cssFiles: string[] = [];
      let latinPreload = "";
      for (const [file, item] of Object.entries(bundle)) {
        if (item.type !== "asset") continue;
        if (file.endsWith(".css")) {
          const src = item.source;
          css += typeof src === "string" ? src : new TextDecoder().decode(src);
          cssFiles.push(file);
        } else if (file.endsWith(".woff2") && file.includes("inter-latin-wght-normal")) {
          latinPreload = `/${file}`;
        }
      }
      if (cssFiles.length === 0) return html;
      let out = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
      for (const f of cssFiles) delete bundle[f];
      const preload = latinPreload
        ? `<link rel="preload" href="${latinPreload}" as="font" type="font/woff2" crossorigin>`
        : "";
      out = out.replace("</head>", `${preload}<style>${css}</style></head>`);
      return out;
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "apple-touch-icon.png", "icon.svg"],
      manifest: {
        name: "MpBuddy — media tools in your browser",
        short_name: "MpBuddy",
        description:
          "Private in-browser media tools. Compress, trim, crop, extract audio. Files never leave your device.",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        orientation: "any",
        theme_color: "#f5f5f7",
        background_color: "#f5f5f7",
        categories: ["utilities", "photo", "video"],
        lang: "en",
        dir: "ltr",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        // App shell precached (JS/HTML/fonts/icons). CSS is inlined into
        // index.html by firstPaint(), so there is no .css file to precache.
        // WASM (~32MB each) must NOT precache — fetched lazily on first run,
        // then runtime-cached so the engine works offline afterwards.
        globPatterns: ["**/*.{js,html,svg,png,ico,woff2,webmanifest}"],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.pathname.endsWith(".wasm") || url.pathname.includes("ffmpeg-core"),
            handler: "CacheFirst",
            options: {
              cacheName: "ffmpeg-core",
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 6, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
        ],
      },
    }),
    firstPaint(),
  ],
  server: { headers: isolateHeaders },
  preview: { headers: isolateHeaders },
  build: { target: "esnext" },
});
