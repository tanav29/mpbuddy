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
      manifest: {
        name: "MpBuddy",
        short_name: "MpBuddy",
        description: "Private in-browser media tools. Files never leave your device.",
        theme_color: "#09090b",
        background_color: "#09090b",
        display: "standalone",
        start_url: ".",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        // WASM (~32MB each) must NOT precache — fetched lazily, then runtime-cached.
        // woff2 included so the bundled Inter font works offline.
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.pathname.endsWith(".wasm") || url.pathname.endsWith("ffmpeg-core.js"),
            handler: "CacheFirst",
            options: { cacheName: "ffmpeg-core", expiration: { maxEntries: 6 } },
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
