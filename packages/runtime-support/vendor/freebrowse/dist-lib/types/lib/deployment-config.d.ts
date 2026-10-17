/**
 * Runtime configuration for one FreeBrowse instance (app or embedded library).
 *
 * These are *deployment* (operator/host-controlled) settings, distinct from
 * per-user preferences, and must never be sourced from user-writable storage.
 *
 * Defaults come from Vite env vars so the app behaves exactly as before
 * (`VITE_SERVERLESS`, `VITE_DISABLE_DOWNLOAD`); an embedding host overrides
 * them at runtime through `configureFreeBrowse` (or the `mountFreeBrowse`
 * options), since a published package has one build and no env.
 *
 * Consumers read through `deploymentConfig` (getters, always current) and the
 * `dataUrl` / `aiUrl` helpers rather than caching values at import time.
 */
export interface FreeBrowseBackend {
    /** Base URL of the `/data` file API (listings, `.nvd` + `.nii` uploads). */
    dataUrl: string;
    /** Base URL of the `/ai` session API. */
    aiUrl: string;
}
export interface FreeBrowseConfig {
    /**
     * Backend endpoints, or `null` for a backend-less ("serverless") viewer: no
     * Save-to-server, no Data/NVD tabs, no AI capability probe.
     */
    backend: FreeBrowseBackend | null;
    /**
     * Lock down client-side data export for secure deployments: disables the
     * Download button and no-ops niivue's save-to-disk methods. Not a guarantee
     * against a determined/malicious user — it stops well-intentioned exports.
     */
    downloadDisabled: boolean;
    /** localStorage key for user preferences, or `false` to keep them in memory. */
    persist: string | false;
    /** Read `?nvd=` / `?vol=` from the page URL on startup (app: yes; library: no). */
    readUrlParams: boolean;
    /** Publish the instance as `window.freebrowse.nv` (app: yes; library: no). */
    exposeGlobal: boolean;
}
export declare const DEFAULT_BACKEND: FreeBrowseBackend;
export declare const DEFAULT_PERSIST_KEY = "freebrowse-user-settings";
/** Override part of the configuration; returns the effective config. */
export declare function configureFreeBrowse(partial: Partial<FreeBrowseConfig>): Readonly<FreeBrowseConfig>;
/** Back to the env-derived defaults (tests). */
export declare function resetFreeBrowseConfig(): void;
/** The effective configuration (live view; do not mutate). */
export declare function getFreeBrowseConfig(): Readonly<FreeBrowseConfig>;
/**
 * The two flags most of the UI keys off. Getters, so a value read inside a
 * render or effect is always the configured one.
 */
export declare const deploymentConfig: {
    /** No backend configured (file:// builds, or an embedding host without one). */
    readonly serverless: boolean;
    readonly downloadDisabled: boolean;
};
/** `dataUrl("nvd")` → `<backend.dataUrl>/nvd`. Throws when no backend is configured. */
export declare function dataUrl(path?: string): string;
/** `aiUrl("session/list")` → `<backend.aiUrl>/session/list`. Throws when no backend. */
export declare function aiUrl(path?: string): string;
/**
 * Strip the configured data base from a URL, returning the path relative to
 * the data root (`"/data/x/y.nii.gz"` → `"x/y.nii.gz"`), or null if the URL is
 * not under it. Accepts the bare relative spelling too (`"data/x"`).
 */
export declare function relativeToDataRoot(url: string): string | null;
