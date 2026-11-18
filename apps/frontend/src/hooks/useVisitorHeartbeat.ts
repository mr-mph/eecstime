import { useEffect } from "react";

const HEARTBEAT_MS = 60_000;
const CLIENT_ID_KEY = "bt.visitorId";

/**
 * A random id this browser keeps across visits, so the same person is
 * recognized across days, networks and browser updates. Null when storage is
 * unavailable (some private modes); the backend then falls back to the
 * fingerprint.
 */
const getClientId = (): string | null => {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
};

// One fingerprint per page load.
let visitorIdPromise: Promise<string> | null = null;
const getVisitorId = () =>
  (visitorIdPromise ??= import("@fingerprintjs/fingerprintjs")
    .then((fingerprint) => fingerprint.load())
    .then((agent) => agent.get())
    .then((result) => result.visitorId));

/**
 * Rough visitor analytics (see apps/backend/src/presence): sends a FingerprintJS
 * visitor id on load and every minute while the tab is visible. Nothing is
 * shown in the UI; counts are logged by the backend.
 */
export default function useVisitorHeartbeat() {
  useEffect(() => {
    const beat = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const visitorId = await getVisitorId();
        await fetch("/api/analytics/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The session cookie also goes along (same origin), which lets the
          // backend link signed-in visitors across devices.
          body: JSON.stringify({ visitorId, clientId: getClientId() }),
          keepalive: true,
        });
      } catch {
        // Analytics are best-effort; ignore network or fingerprinting failures.
      }
    };

    void beat();
    const interval = setInterval(() => void beat(), HEARTBEAT_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
