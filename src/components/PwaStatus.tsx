import { useEffect, useState } from "react";
import { registerSW } from "virtual:pwa-register";

/**
 * Offline + update toasts for the PWA shell.
 * - Service worker uses autoUpdate (skipWaiting + clientsClaim), so a new
 *   version activates immediately; we just offer a one-tap reload.
 * - `navigator.onLine` drives the offline pill — the app shell and the
 *   ffmpeg engine (after first run) are cached, so tools keep working.
 */
export default function PwaStatus() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== "undefined" ? !navigator.onLine : false,
  );

  useEffect(() => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeedRefresh(true);
      },
      onOfflineReady() {
        setOfflineReady(true);
        setTimeout(() => setOfflineReady(false), 4000);
      },
    });

    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    // Expose for the reload button.
    (window as unknown as { __mpbUpdateSW?: typeof updateSW }).__mpbUpdateSW = updateSW;

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const reload = () => {
    const updateSW = (window as unknown as { __mpbUpdateSW?: (r?: boolean) => void })
      .__mpbUpdateSW;
    if (updateSW) updateSW(true);
    else window.location.reload();
  };

  if (!needRefresh && !offlineReady && !isOffline) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      {isOffline && (
        <p className="pointer-events-auto rounded-full bg-[#111] px-4 py-2 font-mono text-[12px] font-medium uppercase tracking-[0.06em] text-white">
          You&apos;re offline — everything still works
        </p>
      )}
      {offlineReady && !isOffline && (
        <p className="pointer-events-auto rounded-full bg-[#111] px-4 py-2 font-mono text-[12px] font-medium uppercase tracking-[0.06em] text-white">
          Ready to work offline
        </p>
      )}
      {needRefresh && (
        <p className="pointer-events-auto flex items-center gap-3 rounded-lg border border-[#eaeaea] bg-white py-2 pl-4 pr-2 text-[14px] font-medium text-[#111]">
          New version available
          <button
            type="button"
            onClick={reload}
            className="btn-primary px-4 py-1.5 text-[14px]"
          >
            Reload
          </button>
        </p>
      )}
    </div>
  );
}
