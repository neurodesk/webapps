/**
 * registerNiiVueEvents — the single event-driven sync bridge between a
 * niivue-mono `NiiVue` instance and FreeBrowse's UI state.
 *
 * niivue-mono's controller extends `EventTarget` and emits a `CustomEvent` for
 * every state mutation that goes through its API (setters + methods). By making
 * FreeBrowse's store a *derived view* updated only from these events, both
 * FreeBrowse's own command wrappers and external code (a developer holding
 * `window.freebrowse.nv`) drive the UI through the identical path.
 *
 * Dedupe strategy: every flat scalar setter emits a generic
 * `change {property, value}`, and a handful ALSO emit a specific event
 * (`sliceTypeChange`, `azimuthElevationChange`, `drawingEnabled`,
 * `penValueChanged`). We subscribe to `change` as the single source of truth for
 * scalars and deliberately ignore those scalar-mirror events, so each scalar is
 * handled exactly once. Specific events are used ONLY where `change` carries no
 * equivalent: structural volume/mesh changes, drawing actions, location, etc.
 *
 * Phase 0: this is the dispatcher skeleton + its {@link NiiVueSyncTarget}
 * contract, verified against the event-emitting mock. The concrete adapter that
 * maps these intent callbacks onto the Zustand store (with niivue->store name
 * and value translation) is added as hooks convert in Phase 2+.
 */
/** Minimal shape of a niivue instance this bridge needs. */
export interface NiiVueEventSource extends EventTarget {
    volumes: unknown[];
    meshes: unknown[];
}
/**
 * Intent-level sink for niivue state changes. Phase 2+ provides a concrete
 * implementation backed by the Zustand store; tests provide spies.
 */
export interface NiiVueSyncTarget {
    /** A flat viewer/scene scalar changed (niivue property name + new value). */
    onViewerOptionChange(property: string, value: unknown): void;
    /** A drawing-related scalar changed (pen value, opacity, colormap, ...). */
    onDrawingOptionChange(property: string, value: unknown): void;
    /** The volume list changed (add / remove / reorder / update) — re-read `volumes`. */
    onVolumesChanged(volumes: unknown[]): void;
    /** A single volume's properties changed, with the exact applied subset. */
    onVolumeUpdated(index: number, changes: Record<string, unknown>): void;
    /** The mesh list or a mesh/layer changed — re-read `meshes`. */
    onSurfacesChanged(meshes: unknown[]): void;
    /** Drawing state changed; `action` is create/close/undo/stroke/load/update. */
    onDrawingChanged(action: string): void;
    /** Crosshair moved (interaction or a location-emitting method). */
    onLocationChange(location: unknown): void;
    /** A document finished loading (volumes/meshes/scene already applied). */
    onDocumentLoaded(): void;
    /** A colormap was registered by name. */
    onColormapAdded(name: string): void;
}
/**
 * Subscribe `target` to all relevant events on `nv`. Returns a teardown that
 * removes every listener (call it on unmount / instance replacement).
 */
export declare function registerNiiVueEvents(nv: NiiVueEventSource, target: NiiVueSyncTarget): () => void;
