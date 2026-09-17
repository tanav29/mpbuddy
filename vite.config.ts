import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// COOP/COEP only matter for the multithreaded ffmpeg core (SharedArrayBuffer).
// Scoped here to dev/preview; apply the same two headers on your host.
const isolateHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [
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
        globPatterns: ["**/*.{js,css,html,svg}"],
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
  ],
  server: { headers: isolateHeaders },
  preview: { headers: isolateHeaders },
  build: { target: "esnext" },
});
