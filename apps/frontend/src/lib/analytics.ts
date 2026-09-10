/**
 * Google Analytics (gtag.js) helpers.
 *
 * Default measurement ID is G-HZZDBQMPDL (loaded from index.html).
 * SPA route changes send page_view via trackGaPageView.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    __GA_MEASUREMENT_ID__?: string;
  }
}

export const GA_MEASUREMENT_ID = "G-HZZDBQMPDL";

export function getGaMeasurementId(): string {
  return (
    import.meta.env.VITE_GA_MEASUREMENT_ID?.trim() ||
    window.__GA_MEASUREMENT_ID__?.trim() ||
    GA_MEASUREMENT_ID
  );
}

/** Ensure gtag.js is present (idempotent). Safe to call on every pageview. */
export function ensureGoogleAnalytics(): string {
  const id = getGaMeasurementId();
  if (typeof document === "undefined") return id;

  if (!window.dataLayer) window.dataLayer = [];
  if (!window.gtag) {
    window.gtag = function gtag(...args: unknown[]) {
      window.dataLayer!.push(args);
    };
    window.gtag("js", new Date());
    window.gtag("config", id, { send_page_view: false });
  }

  const existing = document.querySelector<HTMLScriptElement>(
    `script[data-ga-id="${id}"]`
  );
  if (!existing) {
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://sethw.dev/api/ga.js?id=${id}`;
    script.dataset.gaId = id;
    document.head.appendChild(script);
  }

  return id;
}

/** Record an SPA page view. */
export function trackGaPageView(path: string, title?: string) {
  const id = ensureGoogleAnalytics();
  if (!window.gtag) return;
  window.gtag("event", "page_view", {
    page_path: path,
    page_title: title,
    page_location: `${window.location.origin}${path}`,
    send_to: id,
  });
}
