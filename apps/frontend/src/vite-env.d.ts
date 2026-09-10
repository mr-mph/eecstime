/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OTel collector OTLP endpoint path, e.g. "/otlp". Unset = tracing disabled. */
  readonly VITE_OTEL_ENDPOINT?: string;
  /** Optional override for Google Analytics measurement ID (default G-HZZDBQMPDL). */
  readonly VITE_GA_MEASUREMENT_ID?: string;
  /** Optional override for site origin (default https://eecstime.sethw.dev). */
  readonly VITE_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
