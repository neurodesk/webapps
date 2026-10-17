import { jsx as a, jsxs as y, Fragment as De } from "react/jsx-runtime";
import * as p from "react";
import Q, { useRef as le, useCallback as I, useEffect as oe, forwardRef as jn, createElement as Wt, useState as ce, useMemo as ga } from "react";
import { SHOW_RENDER as Ue, DRAG_MODE as pt, NVWorker as va, NiiVue as ba } from "@niivue/niivue";
import "react-dom";
const wa = /* @__PURE__ */ new Set([
  "drawIsEnabled",
  "drawPenValue",
  "drawPenSize",
  "drawOpacity",
  "drawRimOpacity",
  "drawColormap",
  "drawIsFillOverwriting"
]);
function ot(e) {
  return e.detail;
}
function ya(e, t) {
  const n = [], o = (i, l) => {
    e.addEventListener(i, l), n.push([i, l]);
  };
  o("change", (i) => {
    const { property: l, value: c } = ot(i);
    wa.has(l) ? t.onDrawingOptionChange(l, c) : t.onViewerOptionChange(l, c);
  });
  const r = () => t.onVolumesChanged(e.volumes);
  o("volumeLoaded", r), o("volumeRemoved", r), o("volumeOrderChanged", r), o("frameChange", r), o("volumeUpdated", (i) => {
    const { volumeIndex: l, changes: c } = ot(i);
    t.onVolumeUpdated(l, c), t.onVolumesChanged(e.volumes);
  });
  const s = () => t.onSurfacesChanged(e.meshes);
  return o("meshLoaded", s), o("meshRemoved", s), o("meshUpdated", s), o("drawingChanged", (i) => {
    t.onDrawingChanged(ot(i).action);
  }), o("locationChange", (i) => t.onLocationChange(ot(i))), o("documentLoaded", () => t.onDocumentLoaded()), o("colormapAdded", (i) => {
    t.onColormapAdded(ot(i).name);
  }), () => {
    for (const [i, l] of n)
      e.removeEventListener(i, l);
    n.length = 0;
  };
}
const gt = {
  axial: { sliceType: 0, showRender: Ue.NEVER },
  coronal: { sliceType: 1, showRender: Ue.NEVER },
  sagittal: { sliceType: 2, showRender: Ue.NEVER },
  ACS: { sliceType: 3, showRender: Ue.NEVER },
  ACSR: { sliceType: 3, showRender: Ue.ALWAYS },
  render: { sliceType: 4, showRender: Ue.ALWAYS }
};
function pn(e) {
  const t = e[0].toString(16).padStart(2, "0"), n = e[1].toString(16).padStart(2, "0"), o = e[2].toString(16).padStart(2, "0");
  return `#${t}${n}${o}`;
}
function vt(e) {
  let t = "";
  for (let o = 0; o < e.length; o += 8192) {
    const r = e.subarray(o, o + 8192);
    t += String.fromCharCode(...r);
  }
  return btoa(t);
}
async function bt(e) {
  var n;
  const t = (n = new Response(e).body) == null ? void 0 : n.pipeThrough(
    new CompressionStream("gzip")
  );
  if (!t) throw new Error("gzip: no readable stream from input");
  return new Uint8Array(await new Response(t).arrayBuffer());
}
const gn = (e) => {
  let t;
  const n = /* @__PURE__ */ new Set(), o = (u, d) => {
    const f = typeof u == "function" ? u(t) : u;
    if (!Object.is(f, t)) {
      const m = t;
      t = d ?? (typeof f != "object" || f === null) ? f : Object.assign({}, t, f), n.forEach((w) => w(t, m));
    }
  }, r = () => t, l = { setState: o, getState: r, getInitialState: () => c, subscribe: (u) => (n.add(u), () => n.delete(u)) }, c = t = e(o, r, l);
  return l;
}, xa = (e) => e ? gn(e) : gn, Ca = (e) => e;
function Sa(e, t = Ca) {
  const n = Q.useSyncExternalStore(
    e.subscribe,
    Q.useCallback(() => t(e.getState()), [e, t]),
    Q.useCallback(() => t(e.getInitialState()), [e, t])
  );
  return Q.useDebugValue(n), n;
}
const ka = (e) => {
  const t = xa(e), n = (o) => Sa(t, o);
  return Object.assign(n, t), n;
}, Na = (e) => ka;
function Hn(e, t) {
  let n;
  try {
    n = e();
  } catch {
    return;
  }
  return {
    getItem: (r) => {
      var s;
      const i = (c) => c === null ? null : JSON.parse(c, void 0), l = (s = n.getItem(r)) != null ? s : null;
      return l instanceof Promise ? l.then(i) : i(l);
    },
    setItem: (r, s) => n.setItem(r, JSON.stringify(s, void 0)),
    removeItem: (r) => n.removeItem(r)
  };
}
const Bt = (e) => (t) => {
  try {
    const n = e(t);
    return n instanceof Promise ? n : {
      then(o) {
        return Bt(o)(n);
      },
      catch(o) {
        return this;
      }
    };
  } catch (n) {
    return {
      then(o) {
        return this;
      },
      catch(o) {
        return Bt(o)(n);
      }
    };
  }
}, Aa = (e, t) => (n, o, r) => {
  let s = {
    storage: Hn(() => window.localStorage),
    partialize: (v) => v,
    version: 0,
    merge: (v, h) => ({
      ...h,
      ...v
    }),
    ...t
  }, i = !1, l = 0;
  const c = /* @__PURE__ */ new Set(), u = /* @__PURE__ */ new Set();
  let d = s.storage;
  if (!d)
    return e(
      (...v) => {
        console.warn(
          `[zustand persist middleware] Unable to update item '${s.name}', the given storage is currently unavailable.`
        ), n(...v);
      },
      o,
      r
    );
  const f = () => {
    const v = s.partialize({ ...o() });
    return d.setItem(s.name, {
      state: v,
      version: s.version
    });
  }, m = r.setState;
  r.setState = (v, h) => (m(v, h), f());
  const w = e(
    (...v) => (n(...v), f()),
    o,
    r
  );
  r.getInitialState = () => w;
  let S;
  const b = () => {
    var v, h;
    if (!d) return;
    const g = ++l;
    i = !1, c.forEach((k) => {
      var E;
      return k((E = o()) != null ? E : w);
    });
    const N = ((h = s.onRehydrateStorage) == null ? void 0 : h.call(s, (v = o()) != null ? v : w)) || void 0;
    return Bt(d.getItem.bind(d))(s.name).then((k) => {
      if (k)
        if (typeof k.version == "number" && k.version !== s.version) {
          if (s.migrate) {
            const E = s.migrate(
              k.state,
              k.version
            );
            return E instanceof Promise ? E.then((U) => [!0, U]) : [!0, E];
          }
          console.error(
            "State loaded from storage couldn't be migrated since no migrate function was provided"
          );
        } else
          return [!1, k.state];
      return [!1, void 0];
    }).then((k) => {
      var E;
      if (g !== l)
        return;
      const [U, F] = k;
      if (S = s.merge(
        F,
        (E = o()) != null ? E : w
      ), n(S, !0), U)
        return f();
    }).then(() => {
      g === l && (N == null || N(S, void 0), S = o(), i = !0, u.forEach((k) => k(S)));
    }).catch((k) => {
      g === l && (N == null || N(void 0, k));
    });
  };
  return r.persist = {
    setOptions: (v) => {
      s = {
        ...s,
        ...v
      }, v.storage && (d = v.storage);
    },
    clearStorage: () => {
      d == null || d.removeItem(s.name);
    },
    getOptions: () => s,
    rehydrate: () => b(),
    hasHydrated: () => i,
    onHydrate: (v) => (c.add(v), () => {
      c.delete(v);
    }),
    onFinishHydration: (v) => (u.add(v), () => {
      u.delete(v);
    })
  }, s.skipHydration || b(), S || w;
}, Ma = Aa, Yn = { dataUrl: "/data", aiUrl: "/ai" }, Ea = "freebrowse-user-settings";
function Da() {
  return {
    backend: { ...Yn },
    downloadDisabled: !1,
    persist: Ea,
    readUrlParams: !0,
    exposeGlobal: !0
  };
}
let ve = Da();
function tu(e) {
  return ve = { ...ve, ...e }, ve;
}
function je() {
  return ve;
}
const wt = {
  /** No backend configured (file:// builds, or an embedding host without one). */
  get serverless() {
    return ve.backend === null;
  },
  get downloadDisabled() {
    return ve.downloadDisabled;
  }
};
function Xn(e, t) {
  return e.replace(/\/+$/, "") + "/" + t.replace(/^\/+/, "");
}
function Kn() {
  if (ve.backend === null)
    throw new Error(
      "FreeBrowse: no backend configured (serverless); this call should be unreachable"
    );
  return ve.backend;
}
function fe(e = "") {
  return Xn(Kn().dataUrl, e);
}
function Me(e = "") {
  return Xn(Kn().aiUrl, e);
}
function Ia(e) {
  var r;
  const n = (((r = ve.backend) == null ? void 0 : r.dataUrl) ?? Yn.dataUrl).replace(/\/+$/, "") + "/";
  if (e.startsWith(n)) return e.slice(n.length);
  const o = n.replace(/^\/+/, "");
  return o && e.startsWith(o) ? e.slice(o.length) : null;
}
const Ra = (e) => ({
  currentImageIndex: null,
  showUploader: !0,
  dragDropEnabled: !0,
  volumeVersion: 0,
  setCurrentImageIndex: (t) => e({ currentImageIndex: t }),
  setShowUploader: (t) => e({ showUploader: t }),
  setDragDropEnabled: (t) => e({ dragDropEnabled: t }),
  incrementVolumeVersion: () => e((t) => ({ volumeVersion: t.volumeVersion + 1 }))
}), Pa = (e) => ({
  surfaces: [],
  currentSurfaceIndex: null,
  surfaceToRemove: null,
  selectedLayerIndex: null,
  layerVersion: 0,
  setSurfaces: (t) => e((n) => ({
    surfaces: typeof t == "function" ? t(n.surfaces) : t
  })),
  setCurrentSurfaceIndex: (t) => e({ currentSurfaceIndex: t }),
  setSurfaceToRemove: (t) => e({ surfaceToRemove: t }),
  setSelectedLayerIndex: (t) => e({ selectedLayerIndex: t }),
  incrementLayerVersion: () => e((t) => ({ layerVersion: t.layerVersion + 1 }))
}), Ta = (e) => ({
  drawingOptions: {
    enabled: !1,
    mode: "none",
    penValue: 1,
    penFill: !0,
    penErases: !1,
    opacity: 1,
    colormap: "_draw",
    magicWand2dOnly: !0,
    magicWandMaxDistanceMM: 15,
    magicWandThresholdPercent: 0.05,
    filename: "drawing.nii.gz"
  },
  setDrawingOptions: (t) => e((n) => ({
    drawingOptions: typeof t == "function" ? t(n.drawingOptions) : t
  }))
}), Va = (e) => ({
  viewerOptions: {
    viewMode: "ACS",
    crosshairWidth: 0.3,
    crosshairGap: 10,
    crosshairVisible: !0,
    crosshairColor: [1, 0.88, 0.88, 1],
    rulerWidth: 1,
    rulerVisible: !1,
    interpolateVoxels: !1,
    dragMode: "contrast",
    overlayOutlineWidth: 0,
    isColorbar: !1,
    isRadiologicalConvention: !1,
    sagittalNoseLeft: !1
  },
  darkMode: !0,
  sidebarOpen: !0,
  footerOpen: !0,
  activeTab: "sceneDetails",
  settingsDialogOpen: !1,
  removeDialogOpen: !1,
  volumeToRemove: null,
  skipRemoveConfirmation: !1,
  imagingUploadConfirmDialogOpen: !1,
  skipImagingUploadConfirmation: !1,
  sessionDeleteConfirmDialogOpen: !1,
  skipSessionDeleteConfirmation: !1,
  setViewerOptions: (t) => e((n) => ({
    viewerOptions: typeof t == "function" ? t(n.viewerOptions) : t
  })),
  setDarkMode: (t) => e({ darkMode: t }),
  setSidebarOpen: (t) => e({ sidebarOpen: t }),
  setFooterOpen: (t) => e({ footerOpen: t }),
  setActiveTab: (t) => e({ activeTab: t }),
  setSettingsDialogOpen: (t) => e({ settingsDialogOpen: t }),
  setRemoveDialogOpen: (t) => e({ removeDialogOpen: t }),
  setVolumeToRemove: (t) => e({ volumeToRemove: t }),
  setSkipRemoveConfirmation: (t) => e({ skipRemoveConfirmation: t }),
  setImagingUploadConfirmDialogOpen: (t) => e({ imagingUploadConfirmDialogOpen: t }),
  setSkipImagingUploadConfirmation: (t) => e({ skipImagingUploadConfirmation: t }),
  setSessionDeleteConfirmDialogOpen: (t) => e({ sessionDeleteConfirmDialogOpen: t }),
  setSkipSessionDeleteConfirmation: (t) => e({ skipSessionDeleteConfirmation: t })
}), Oa = (e) => ({
  saveDialogOpen: !1,
  saveState: {
    isDownloadMode: !1,
    document: {
      enabled: !1,
      location: "",
      format: "json"
    },
    volumes: []
  },
  setSaveDialogOpen: (t) => e({ saveDialogOpen: t }),
  setSaveState: (t) => e((n) => ({
    saveState: typeof t == "function" ? t(n.saveState) : t
  }))
}), _a = (e) => ({
  locationData: null,
  setLocationData: (t) => e({ locationData: t })
}), La = (e) => ({
  aiEnabled: null,
  aiSessions: [],
  aiActiveSession: null,
  setAiEnabled: (t) => e({ aiEnabled: t }),
  setAiSessions: (t) => e({ aiSessions: t }),
  setAiActiveSession: (t) => e({ aiActiveSession: t })
}), Ot = /* @__PURE__ */ new Map(), Fa = {
  getItem: (e) => {
    const t = je().persist;
    if (t === !1) return Ot.get("prefs") ?? null;
    try {
      return localStorage.getItem(t);
    } catch {
      return null;
    }
  },
  setItem: (e, t) => {
    const n = je().persist;
    if (n === !1) {
      Ot.set("prefs", t);
      return;
    }
    try {
      localStorage.setItem(n, t);
    } catch {
    }
  },
  removeItem: (e) => {
    const t = je().persist;
    if (t === !1) {
      Ot.delete("prefs");
      return;
    }
    try {
      localStorage.removeItem(t);
    } catch {
    }
  }
}, A = Na()(
  Ma(
    (...e) => ({
      ...Ra(...e),
      ...Pa(...e),
      ...Ta(...e),
      ...Va(...e),
      ...Oa(...e),
      ..._a(...e),
      ...La(...e)
    }),
    {
      name: "freebrowse-user-settings",
      // label only; the key comes from config
      // The adapter is static; it resolves the key/target on every call.
      storage: Hn(() => Fa),
      version: 1,
      // bump + add migrate() on future schema changes
      // Persist ONLY user preferences. Everything else — niivue viewerOptions,
      // loaded volumes/surfaces, dialog-open flags, crosshair location, AI
      // sessions, save state, version counters — is intentionally excluded so
      // that e.g. a loaded document cannot hijack the user's defaults.
      partialize: (e) => ({
        skipRemoveConfirmation: e.skipRemoveConfirmation,
        skipImagingUploadConfirmation: e.skipImagingUploadConfirmation,
        skipSessionDeleteConfirmation: e.skipSessionDeleteConfirmation,
        darkMode: e.darkMode,
        sidebarOpen: e.sidebarOpen,
        footerOpen: e.footerOpen
      })
    }
  )
);
function Ua(e) {
  return e ? [
    Math.round(e[0] * 255),
    Math.round(e[1] * 255),
    Math.round(e[2] * 255),
    Math.round(e[3] * 255)
  ] : [255, 255, 0, 255];
}
function za(e) {
  const t = Object.entries(pt).find(([, n]) => n === e);
  return (t == null ? void 0 : t[0]) ?? "contrast";
}
function Wa(e) {
  const t = Object.entries(gt).find(
    ([, o]) => o.sliceType === e.sliceType && o.showRender === e.showRender
  );
  if (t) return t[0];
  const n = Object.entries(gt).find(
    ([, o]) => o.sliceType === e.sliceType
  );
  return (n == null ? void 0 : n[0]) ?? "ACS";
}
function qn(e, t, n) {
  switch (t) {
    case "crosshairGap":
      return { crosshairGap: n };
    case "crosshairColor":
      return { crosshairColor: n };
    case "rulerWidth":
      return { rulerWidth: n };
    case "isRulerVisible":
      return { rulerVisible: n };
    case "volumeIsNearestInterpolation":
      return { interpolateVoxels: !n };
    case "volumeOutlineWidth":
      return { overlayOutlineWidth: n };
    case "isColorbarVisible":
      return { isColorbar: n };
    case "isRadiological":
      return { isRadiologicalConvention: n };
    case "secondaryDragMode":
      return { dragMode: za(n) };
    case "sliceType":
    case "showRender":
      return { viewMode: Wa(e) };
    default:
      return null;
  }
}
const Ba = [
  "crosshairGap",
  "crosshairColor",
  "rulerWidth",
  "isRulerVisible",
  "volumeIsNearestInterpolation",
  "volumeOutlineWidth",
  "isColorbarVisible",
  "isRadiological",
  "secondaryDragMode",
  "sliceType"
];
function $a(e) {
  const t = {};
  for (const n of Ba) {
    const o = e[n];
    o !== void 0 && Object.assign(t, qn(e, n, o));
  }
  return typeof e.crosshairWidth == "number" && (e.crosshairWidth > 0 ? (t.crosshairVisible = !0, t.crosshairWidth = e.crosshairWidth) : t.crosshairVisible = !1), t;
}
function Ga(e) {
  const t = () => A.getState(), n = (o) => t().setViewerOptions((r) => ({ ...r, ...o }));
  return {
    onViewerOptionChange(o, r) {
      const s = qn(e, o, r);
      s && n(s);
    },
    onDrawingOptionChange(o, r) {
      const s = t();
      switch (o) {
        case "drawOpacity":
          s.setDrawingOptions((i) => ({
            ...i,
            opacity: r
          }));
          break;
        case "drawColormap":
          s.setDrawingOptions((i) => ({
            ...i,
            colormap: r
          }));
          break;
      }
    },
    onVolumesChanged(o) {
      const r = t();
      r.incrementVolumeVersion(), o.length > 0 && r.showUploader && r.setShowUploader(!1);
    },
    onVolumeUpdated() {
      t().incrementVolumeVersion();
    },
    onSurfacesChanged() {
      queueMicrotask(() => {
        const o = e.meshes;
        t().setSurfaces(
          o.map((r, s) => ({
            id: `surface-${s}`,
            name: r.name || `Surface ${s + 1}`,
            // niivue-mono does not render a mesh `visible` flag, so FreeBrowse
            // models surface visibility via opacity (0 == hidden), like volumes.
            visible: (r.opacity ?? 1) > 0,
            opacity: r.opacity ?? 1,
            rgba255: Ua(r.color),
            shaderType: r.shaderType || "phong"
          }))
        ), t().incrementLayerVersion();
      });
    },
    onDrawingChanged() {
      const o = e.drawingVolume != null;
      t().setDrawingOptions((r) => ({ ...r, enabled: o })), t().incrementVolumeVersion();
    },
    onLocationChange(o) {
      const r = o;
      if (!r) return;
      const s = (r.values ?? []).map((i, l) => {
        const c = i.vox ?? [0, 0, 0];
        return {
          name: i.name || `Volume ${l + 1}`,
          voxel: [
            Math.round(c[0]),
            Math.round(c[1]),
            Math.round(c[2])
          ],
          value: i.value ?? 0
        };
      });
      t().setLocationData({ mm: r.mm ?? [0, 0, 0], voxels: s });
    },
    onDocumentLoaded() {
      t().incrementVolumeVersion(), t().incrementLayerVersion();
    },
    onColormapAdded() {
    }
  };
}
function Xt(e, t = "none") {
  const n = A((C) => C.viewerOptions), o = A((C) => C.setViewerOptions), r = le(null), s = le(null), i = I(() => {
    r.current && clearTimeout(r.current), r.current = setTimeout(() => {
      e.current && e.current.updateGLVolume();
    }, 100);
  }, [e]);
  oe(() => () => {
    r.current && clearTimeout(r.current), s.current && clearTimeout(s.current);
  }, []);
  const l = I(() => {
    const C = e.current;
    if (!C) return;
    const x = A.getState().viewerOptions;
    C.crosshairWidth = x.crosshairVisible ? x.crosshairWidth : 0, C.crosshairGap = x.crosshairGap, C.crosshairColor = x.crosshairColor, C.rulerWidth = x.rulerWidth, C.isRulerVisible = x.rulerVisible, C.volumeIsNearestInterpolation = !x.interpolateVoxels, C.secondaryDragMode = pt[x.dragMode], C.volumeOutlineWidth = x.overlayOutlineWidth, C.isColorbarVisible = x.isColorbar, C.isRadiological = x.isRadiologicalConvention;
    const M = gt[x.viewMode];
    M ? (C.showRender = M.showRender, C.sliceType = M.sliceType) : C.sliceType = 0;
  }, [e]), c = I(() => {
    const C = e.current;
    if (!C) return;
    const x = $a(C);
    Object.keys(x).length !== 0 && o((M) => ({ ...M, ...x }));
  }, [e, o]), u = le(!1);
  oe(() => {
    t === "none" || u.current || !e.current || (u.current = !0, t === "apply" ? l() : c());
  }, [t, l, c, e]);
  const d = I(
    (C) => {
      const x = e.current, M = gt[C];
      !x || !M || (x.showRender = M.showRender, x.sliceType = M.sliceType);
    },
    [e]
  ), f = I(
    (C) => {
      e.current && (e.current.secondaryDragMode = pt[C]);
    },
    [e]
  ), m = I(
    (C) => {
      o((M) => ({ ...M, crosshairWidth: C }));
      const x = e.current;
      x && (x.crosshairWidth = n.crosshairVisible ? C : 0);
    },
    [e, o, n.crosshairVisible]
  ), w = I(
    (C) => {
      o((M) => ({ ...M, crosshairVisible: C }));
      const x = e.current;
      x && (x.crosshairWidth = C ? n.crosshairWidth : 0);
    },
    [e, o, n.crosshairWidth]
  ), S = I(
    (C) => {
      e.current && (e.current.crosshairGap = C);
    },
    [e]
  ), b = I(
    (C) => {
      const x = C.replace("#", ""), M = parseInt(x.substr(0, 2), 16) / 255, V = parseInt(x.substr(2, 2), 16) / 255, R = parseInt(x.substr(4, 2), 16) / 255, O = n.crosshairColor[3];
      s.current && clearTimeout(s.current), s.current = setTimeout(() => {
        e.current && (e.current.crosshairColor = [M, V, R, O]);
      }, 50);
    },
    [n.crosshairColor, e]
  ), v = I(
    (C) => {
      e.current && (e.current.volumeIsNearestInterpolation = !C);
    },
    [e]
  ), h = I(
    (C) => {
      e.current && (e.current.rulerWidth = C);
    },
    [e]
  ), g = I(
    (C) => {
      e.current && (e.current.isRulerVisible = C);
    },
    [e]
  ), N = I(
    (C) => {
      e.current && (e.current.isColorbarVisible = C);
    },
    [e]
  ), k = I(
    (C) => {
      e.current && (e.current.isRadiological = C);
    },
    [e]
  ), E = I(
    (C) => {
      o((x) => ({ ...x, sagittalNoseLeft: C }));
    },
    [o]
  ), U = I(
    (C) => {
      e.current && (e.current.volumeOutlineWidth = C);
    },
    [e]
  ), F = I(() => {
    const C = e.current;
    C && (C.scaleMultiplier = 1, C.pan2Dxyzmm = [0, 0, 0, 1], C.crosshairPos = [0.5, 0.5, 0.5], C.azimuth = 110, C.elevation = 10, (C.volumes ?? []).forEach((x, M) => {
      x.robustMin !== void 0 && x.robustMax !== void 0 && C.setVolume(M, { calMin: x.robustMin, calMax: x.robustMax });
    }));
  }, [e]);
  return {
    viewerOptions: n,
    setViewerOptions: o,
    applyViewerOptions: l,
    syncViewerOptionsFromNiiVue: c,
    debouncedGLUpdate: i,
    handleViewMode: d,
    handleDragModeChange: f,
    handleCrosshairWidthChange: m,
    handleCrosshairGapChange: S,
    handleInterpolateVoxelsChange: v,
    handleCrosshairVisibleChange: w,
    handleCrosshairColorChange: b,
    handleRulerWidthChange: h,
    handleRulerVisibleChange: g,
    handleOverlayOutlineWidthChange: U,
    handleColorbarChange: N,
    handleRadiologicalChange: k,
    handleSagittalNoseLeftChange: E,
    resetViewAndContrast: F
  };
}
const Jn = /* @__PURE__ */ new Set(["freesurfer", "roi_i256"]);
async function ja(e) {
  const t = e.volumes || [];
  for (let n = 0; n < t.length; n++) {
    const o = t[n], r = typeof o.colormap == "string" ? o.colormap : "";
    !r || o.colormapLabel || Jn.has(r.toLowerCase()) && await e.setColormapLabel(n, r);
  }
}
function Ha(e, t, n) {
  const o = A((D) => D.currentImageIndex), r = A(
    (D) => D.setCurrentImageIndex
  ), s = A((D) => D.volumeVersion), i = A(
    (D) => D.incrementVolumeVersion
  ), l = A((D) => D.volumeToRemove), c = A((D) => D.setVolumeToRemove), u = A(
    (D) => D.skipRemoveConfirmation
  ), d = A((D) => D.setRemoveDialogOpen), f = A((D) => D.surfaceToRemove), m = A((D) => D.setSurfaceToRemove), w = A((D) => D.drawingOptions), S = A((D) => D.setDrawingOptions), b = A((D) => D.setActiveTab), v = I(() => {
    const D = e.current;
    return D ? D.volumes || [] : [];
  }, [e, s]), h = I(
    (D) => {
      const P = e.current;
      if (!P) return;
      const W = P.volumes.findIndex((re) => re.id === D);
      if (W < 0) return;
      const T = P.volumes[W];
      P.setVolume(W, { visible: T.visible === !1 }), i();
    },
    [e, i]
  ), g = I(
    (D) => {
      const P = e.current;
      o === null || !P || !P.volumes[o] || (P.setVolume(o, { opacity: D }), i());
    },
    [o, e, i]
  ), N = I(
    (D) => {
      const P = e.current;
      if (o === null || !P || !P.volumes[o])
        return;
      const W = P.volumes[o].id;
      W && (P.setFrame4D(W, D), i());
    },
    [o, e, i]
  ), k = I(
    (D) => {
      const P = e.current;
      o === null || !P || !P.volumes[o] || P.setVolume(o, { calMin: D });
    },
    [o, e]
  ), E = I(
    (D) => {
      const P = e.current;
      o === null || !P || !P.volumes[o] || P.setVolume(o, { calMax: D });
    },
    [o, e]
  ), U = I(
    (D) => {
      const P = D.target.value, W = e.current;
      o === null || !W || !W.volumes[o] || (W.setVolume(o, { colormap: P }), Jn.has(P.toLowerCase()) ? W.setColormapLabel(o, P) : W.setColormapLabel(o, null));
    },
    [o, e]
  ), F = I(() => {
    const D = e.current;
    o === null || !D || !D.volumes[o] || o !== 0 && (D.moveVolumeDown(o), r(o - 1), i());
  }, [o, e, r, i]), C = I(() => {
    const D = e.current;
    o === null || !D || !D.volumes[o] || o >= D.volumes.length - 1 || (D.moveVolumeUp(o), r(o + 1), i());
  }, [o, e, r, i]), x = I(
    (D) => {
      const P = e.current;
      !P || !P.volumes[D] || (P.removeVolume(D), i(), o === D ? D > 0 ? r(D - 1) : P.volumes.length > 0 ? r(0) : r(null) : o !== null && o > D && r(o - 1));
    },
    [o, e, i, r]
  ), M = I(
    (D) => {
      u ? x(D) : (c(D), d(!0));
    },
    [
      u,
      x,
      c,
      d
    ]
  ), V = I(
    async (D) => {
      const P = e.current;
      if (!P || !P.volumes[D]) return;
      const W = P.volumes[D], T = W.colormap, re = (W.name || "edit.nii").replace(
        /\.gz$/i,
        ""
      ), ae = await P.saveVolume({
        filename: "",
        volumeByIndex: D
      });
      if (!(ae instanceof Uint8Array)) return;
      const de = new File([ae], re, {
        type: "application/octet-stream"
      });
      if (await P.removeVolume(D), await P.loadDrawing(de), T && (P.drawColormap = T), P.drawPenValue = w.penErases ? 0 : w.penValue, P.drawPenFilled = w.penFill, P.drawIsFillOverwriting = w.penFill, P.drawIsEnabled = !0, S((ie) => ({ ...ie, mode: "pen" })), o !== null && o >= D) {
        const ie = Math.max(0, o - 1);
        r(P.volumes.length > 0 ? ie : null);
      }
      b("drawing");
    },
    [
      e,
      o,
      w.penErases,
      w.penValue,
      w.penFill,
      r,
      S,
      b
    ]
  ), R = I(
    (D) => {
      const P = e.current;
      if (!P || !P.volumes[D]) return !1;
      const W = P.volumes[D], T = P.volumes[0];
      if (!T || W === T || !W.hdr || !T.hdr || W.hdr.datatypeCode !== 2) return !1;
      const re = W.hdr.dims, ae = T.hdr.dims;
      if (re[1] !== ae[1] || re[2] !== ae[2] || re[3] !== ae[3] || !W.hdr.affine || !T.hdr.affine) return !1;
      const de = W.hdr.affine, ie = T.hdr.affine;
      for (let q = 0; q < 4; q++)
        for (let Z = 0; Z < 4; Z++) {
          const me = q * 4 + Z, ye = Number(de[me]), J = Number(ie[me]);
          if (Math.abs(ye - J) > 1e-4)
            return !1;
        }
      return !0;
    },
    [e]
  ), O = I(() => {
    l !== null && x(l), f !== null && n(f), d(!1), c(null), m(null);
  }, [
    l,
    x,
    f,
    n,
    d,
    c,
    m
  ]), H = I(() => {
    d(!1), c(null), m(null);
  }, [d, c, m]);
  return {
    getVolumes: v,
    toggleImageVisibility: h,
    handleOpacityChange: g,
    handleFrameChange: N,
    handleContrastMinChange: k,
    handleContrastMaxChange: E,
    handleColormapChange: U,
    handleMoveVolumeUp: F,
    handleMoveVolumeDown: C,
    removeVolume: x,
    handleRemoveVolumeClick: M,
    handleEditVolume: V,
    canEditVolume: R,
    handleConfirmRemove: O,
    handleCancelRemove: H
  };
}
function Ya(e, t) {
  const n = A((b) => b.currentSurfaceIndex), o = A(
    (b) => b.setCurrentSurfaceIndex
  );
  A((b) => b.surfaceToRemove);
  const r = A((b) => b.setSurfaceToRemove), s = A(
    (b) => b.skipRemoveConfirmation
  ), i = A((b) => b.setRemoveDialogOpen), l = le(null);
  oe(() => () => {
    l.current && clearTimeout(l.current);
  }, []);
  const c = I(() => {
  }, []), u = I(
    // Index-based: niivue-mono meshes have no stable id (unlike volumes), so
    // all mesh ops are addressed by index.
    (b) => {
      const v = e.current, h = v == null ? void 0 : v.meshes[b];
      if (!v || !h) return;
      const g = (h.opacity ?? 1) > 0;
      v.setMesh(b, { opacity: g ? 0 : 1 });
    },
    [e]
  ), d = I(
    (b) => {
      const v = e.current;
      !v || !v.meshes[b] || (v.removeMesh(b), n === b ? b > 0 ? o(b - 1) : v.meshes.length > 1 ? o(0) : o(null) : n !== null && n > b && o(n - 1));
    },
    [e, n, o]
  ), f = I(
    (b) => {
      s ? d(b) : (r(b), i(!0));
    },
    [
      s,
      d,
      r,
      i
    ]
  ), m = I(
    (b) => {
      const v = e.current;
      n === null || !v || !v.meshes[n] || v.setMesh(n, { opacity: b });
    },
    [n, e]
  ), w = I(
    (b) => {
      const v = e.current;
      if (n === null || !v || !v.meshes[n])
        return;
      const h = parseInt(b.slice(1, 3), 16), g = parseInt(b.slice(3, 5), 16), N = parseInt(b.slice(5, 7), 16), k = n;
      l.current && clearTimeout(l.current), l.current = setTimeout(() => {
        e.current && e.current.setMesh(k, { rgba255: [h, g, N, 255] });
      }, 50);
    },
    [n, e]
  ), S = I(
    (b) => {
      const v = e.current;
      n === null || !v || !v.meshes[n] || v.setMesh(n, { shaderType: b });
    },
    [n, e]
  );
  return {
    updateSurfaceDetails: c,
    toggleSurfaceVisibility: u,
    removeSurface: d,
    handleRemoveSurfaceClick: f,
    handleSurfaceOpacityChange: m,
    handleSurfaceColorChange: w,
    handleMeshShaderChange: S
  };
}
function Xa(e) {
  const t = A((h) => h.currentSurfaceIndex), n = A((h) => h.selectedLayerIndex), o = A(
    (h) => h.setSelectedLayerIndex
  ), r = A((h) => h.layerVersion), s = le(null);
  oe(() => {
    o(null);
  }, [t, o]);
  const i = I(() => {
    const h = e.current;
    return h && t !== null && h.meshes[t] ? h.meshes[t].layers || [] : [];
  }, [e, t, r]), l = I(
    async (h) => {
      const g = e.current;
      if (!g || t === null || !g.meshes[t])
        return;
      await g.addMeshLayer(t, {
        url: h,
        name: h.name,
        opacity: 0.5
      });
      const N = g.meshes[t].layers || [];
      o(N.length - 1);
    },
    [e, t, o]
  ), c = I(
    (h) => {
      const g = e.current;
      !g || t === null || !g.meshes[t] || (g.removeMeshLayer(t, h), n === h ? o(null) : n !== null && n > h && o(n - 1));
    },
    [e, t, n, o]
  ), u = I(
    (h) => {
      const g = e.current;
      !g || t === null || n === null || !g.meshes[t] || g.setMeshLayerProperty(
        t,
        n,
        h
      );
    },
    [e, t, n]
  ), d = I(
    (h) => u({ opacity: h }),
    [u]
  ), f = I(
    (h) => u({ calMin: h }),
    [u]
  ), m = I(
    (h) => u({ calMax: h }),
    [u]
  ), w = I(
    async (h) => u({ colormap: h }),
    [u]
  ), S = I(
    // niivue-mono has no `useNegativeCmap` boolean; enabling a negative colormap
    // means setting `colormapNegative` to a colormap name ('' disables).
    async (h) => u({ colormapNegative: h ? "winter" : "" }),
    [u]
  ), b = I(() => {
    var h;
    (h = s.current) == null || h.click();
  }, []), v = I(
    async (h) => {
      if (h.target.files && h.target.files.length > 0) {
        const g = Array.from(h.target.files);
        for (const N of g)
          await l(N);
      }
      h.target.value = "";
    },
    [l]
  );
  return {
    layerFileInputRef: s,
    getLayers: i,
    addLayerFromFile: l,
    removeLayer: c,
    handleLayerOpacityChange: d,
    handleLayerCalMinChange: f,
    handleLayerCalMaxChange: m,
    handleLayerColormapChange: w,
    handleLayerUseNegativeCmapChange: S,
    handleAddLayerFiles: b,
    handleLayerFileChange: v
  };
}
function Ka(e, t) {
  const n = A((h) => h.drawingOptions), o = A((h) => h.setDrawingOptions), r = A((h) => h.setActiveTab), s = I(() => {
    const h = e.current;
    !h || !h.volumes[0] || (h.createEmptyDrawing(), h.drawColormap = n.colormap, h.drawOpacity = n.opacity, h.drawPenFilled = n.penFill, h.drawIsEnabled = !1, o((g) => ({ ...g, mode: "none" })), r("drawing"));
  }, [
    e,
    n.colormap,
    n.opacity,
    n.penFill,
    o,
    r
  ]), i = I(
    (h) => {
      o((N) => ({ ...N, mode: h }));
      const g = e.current;
      g && (h === "pen" ? (g.drawPenValue = n.penErases ? 0 : n.penValue, g.drawPenFilled = n.penFill, g.drawIsFillOverwriting = n.penFill, g.drawIsEnabled = !0) : g.drawIsEnabled = !1);
    },
    [
      e,
      n.penErases,
      n.penValue,
      n.penFill,
      o
    ]
  ), l = I(
    (h) => {
      o((N) => ({ ...N, penValue: h }));
      const g = e.current;
      g && n.mode === "pen" && !n.penErases && (g.drawPenValue = h);
    },
    [e, n.mode, n.penErases, o]
  ), c = I(
    (h) => {
      o((N) => ({ ...N, penErases: h }));
      const g = e.current;
      g && n.mode === "pen" && (g.drawPenValue = h ? 0 : n.penValue);
    },
    [e, n.mode, n.penValue, o]
  ), u = I(
    // store-owned: drawPenFilled is a plain field (no event to mirror). "Pen
    // fill" = flood-fill the enclosed shape (drawPenFilled) AND overwrite
    // existing labels (drawIsFillOverwriting), matching old FreeBrowse.
    (h) => {
      o((N) => ({ ...N, penFill: h }));
      const g = e.current;
      g && (g.drawPenFilled = h, g.drawIsFillOverwriting = h);
    },
    [e, o]
  ), d = I(
    // event-mirrored (opacity follows drawOpacity)
    (h) => {
      const g = e.current;
      g && (g.drawOpacity = h);
    },
    [e]
  ), f = I(
    // event-mirrored (colormap follows drawColormap). Options come from
    // nv.drawingColormapNames() — the `_`-prefixed draw LUTs, not nv.colormaps.
    (h) => {
      const g = e.current;
      g && (g.drawColormap = h.target.value);
    },
    [e]
  ), m = I(() => {
    const h = e.current;
    h && h.drawUndo();
  }, [e]), w = I(
    (h) => o((g) => ({ ...g, magicWand2dOnly: h })),
    [o]
  ), S = I(
    (h) => o((g) => ({ ...g, magicWandMaxDistanceMM: h })),
    [o]
  ), b = I(
    (h) => o((g) => ({
      ...g,
      magicWandThresholdPercent: h
    })),
    [o]
  ), v = I(async () => {
    const h = e.current;
    if (!h || !h.drawingVolume) return;
    const g = await h.saveVolume({
      filename: "",
      isSaveDrawing: !0,
      volumeByIndex: 0
    });
    if (!(g instanceof Uint8Array)) return;
    const N = n.filename.replace(/\.gz$/i, ""), k = new File([g], N, { type: "application/octet-stream" });
    h.drawIsEnabled = !1, h.closeDrawing(), await h.addVolume({ url: k, name: N });
    const E = h.volumes.length - 1;
    E >= 0 && (await h.setVolume(E, { colormap: "roi_i256" }), await h.setColormapLabel(E, "roi_i256")), o((U) => ({ ...U, mode: "none" })), r("sceneDetails");
  }, [e, n.filename, o, r]);
  return {
    handleCreateDrawingLayer: s,
    handleDrawingColormapChange: f,
    handleDrawModeChange: i,
    handlePenFillChange: u,
    handlePenErasesChange: c,
    handlePenValueChange: l,
    handleDrawingOpacityChange: d,
    handleMagicWand2dOnlyChange: w,
    handleMagicWandMaxDistanceChange: S,
    handleMagicWandThresholdChange: b,
    handleDrawUndo: m,
    handleSaveDrawing: v
  };
}
const Zn = '(function(){"use strict";const X={AXIAL:0,CORONAL:1};function ct(t,e){const{dimX:o,dimY:r,dimZ:s}=e;return t===X.AXIAL?{w:o,h:r,depth:s}:t===X.CORONAL?{w:o,h:s,depth:r}:{w:r,h:s,depth:o}}function Y(t,e,o,r){return t+e*r.dimX+o*r.dimX*r.dimY}function j(t,e,o,r,s){if(!s)return Y(t,e,o,r);const{img2RASstep:i,img2RASstart:n}=s;return n[0]+t*i[0]+n[1]+e*i[1]+n[2]+o*i[2]}function U(t,e,o,r){const{dimX:s,dimY:i,dimZ:n}=r;if(e===X.AXIAL){const c=new Float32Array(s*i),f=t*s*i;for(let a=0;a<c.length;a++)c[a]=o[f+a];return c}if(e===X.CORONAL){const c=new Float32Array(s*n);for(let f=0;f<n;f++)for(let a=0;a<s;a++)c[a+f*s]=o[Y(a,t,f,r)];return c}const l=new Float32Array(i*n);for(let c=0;c<n;c++)for(let f=0;f<i;f++)l[f+c*i]=o[Y(t,f,c,r)];return l}function J(t,e,o,r,s,i){const{dimX:n,dimY:l,dimZ:c}=r,f=1/s;if(e===X.AXIAL){const u=new Float32Array(n*l);for(let h=0;h<l;h++)for(let p=0;p<n;p++)u[p+h*n]=o[j(p,h,t,r,i)]*f;return u}if(e===X.CORONAL){const u=new Float32Array(n*c);for(let h=0;h<c;h++)for(let p=0;p<n;p++)u[p+h*n]=o[j(p,t,h,r,i)]*f;return u}const a=new Float32Array(l*c);for(let u=0;u<c;u++)for(let h=0;h<l;h++)a[h+u*l]=o[j(t,h,u,r,i)]*f;return a}function wt(t,e,o,r,s,i,n){const{dimX:l,dimY:c,dimZ:f}=s;if(o===X.AXIAL){const a=e*l*c;for(let u=0;u<t.length;u++)t[u]>=i&&(r[a+u]=n)}else if(o===X.CORONAL)for(let a=0;a<f;a++)for(let u=0;u<l;u++)t[u+a*l]>=i&&(r[Y(u,e,a,s)]=n);else for(let a=0;a<f;a++)for(let u=0;u<c;u++)t[u+a*c]>=i&&(r[Y(e,u,a,s)]=n)}function ft(t,e,o){if(e<3||o<3)return;const r=new Float32Array(t.length);for(let s=0;s<o;s++)for(let i=0;i<e;i++){const n=i+s*e;r[n]=i===0||i===e-1?t[n]:(t[n-1]+2*t[n]+t[n+1])*.25}for(let s=0;s<o;s++)for(let i=0;i<e;i++){const n=i+s*e;t[n]=s===0||s===o-1?r[n]:(r[n-e]+2*r[n]+r[n+e])*.25}}function pt(t,e,o,r){const s=Math.abs(o-t),i=Math.abs(o-e),n=Math.exp(-s*s/(2*r*r)),l=Math.exp(-i*i/(2*r*r)),c=n+l;return c<1e-6?.5:n/c}function bt(t,e,o){const{depth:r}=ct(t,o);let s=-1,i=-1;for(let n=0;n<r;n++){const l=U(n,t,e,o);let c=!1;for(let f=0;f<l.length;f++)if(l[f]>0){c=!0;break}c&&(s===-1&&(s=n),i=n)}return s===-1?null:{first:s,last:i}}function xt(t,e,o,r,s,i,n,l){const c=n.sliceType??X.AXIAL,{w:f,h:a,depth:u}=ct(c,e),h=u-1,p={intensityWeight:n.intensityWeight??.7,binaryThreshold:n.binaryThreshold??.375,intensitySigma:n.intensitySigma??.1,applySmoothingToSlices:n.applySmoothingToSlices??!0,useIntensityGuided:n.useIntensityGuided??!1};if(s!==void 0&&i!==void 0){if(s>=i)throw new Error("Low slice index must be less than high slice index");if(s<0||i>h)throw new Error(`Slice indices out of bounds [0, ${h}]`)}const C=new Map;for(let b=0;b<=h;b++){const N=U(b,c,t,e);for(let y=0;y<N.length;y++){const g=N[y];if(g>0){const x=C.get(g);x?(x.min=Math.min(x.min,b),x.max=Math.max(x.max,b)):C.set(g,{min:b,max:b})}}}for(const[b,N]of C){const y=s!==void 0?Math.max(s,N.min):N.min,g=i!==void 0?Math.min(i,N.max):N.max;if(y>=g||g-y<2)continue;const x=U(y,c,t,e),O=U(g,c,t,e),M=new Float32Array(x.length),I=new Float32Array(O.length);for(let A=0;A<x.length;A++)M[A]=x[A]===b?1:0,I[A]=O[A]===b?1:0;p.applySmoothingToSlices&&(ft(M,f,a),ft(I,f,a));for(let A=y+1;A<g;A++){const E=new Float32Array(f*a),d=(A-y)/(g-y),w=1-d;if(p.useIntensityGuided&&o){const m=J(y,c,o,e,r,l),v=J(g,c,o,e,r,l),nt=J(A,c,o,e,r,l),Z=p.intensityWeight;for(let F=0;F<M.length;F++)if(M[F]>0||I[F]>0){const et=pt(m[F],v[F],nt[F],p.intensitySigma),D=Z*et+(1-Z)*w,ot=1-D;E[F]=M[F]*D+I[F]*ot}else E[F]=M[F]*w+I[F]*d}else for(let m=0;m<M.length;m++)E[m]=M[m]*w+I[m]*d;wt(E,A,c,t,e,p.binaryThreshold,b)}}return t}function k(t,e,o,r){return t+e*r.dimX+o*r.dimX*r.dimY}function lt(t,e,o,r,s){if(!s)return k(t,e,o,r);const{img2RASstep:i,img2RASstart:n}=s;return n[0]+t*i[0]+n[1]+e*i[1]+n[2]+o*i[2]}const K=[[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]],at=[[-1,-1,0],[1,-1,0],[-1,1,0],[1,1,0],[0,-1,-1],[0,1,-1],[-1,0,-1],[1,0,-1],[0,-1,1],[0,1,1],[-1,0,1],[1,0,1]],Mt=[[-1,-1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],[-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]];function ut(t){return t>=26?[...K,...at,...Mt]:t>=18?[...K,...at]:[...K]}function dt(t,e,o,r,s={},i,n){const{tolerance:l=0,thresholdMode:c="symmetric",percent:f=0,calMin:a=0,calMax:u=1,connectivity:h=6,maxDistanceMM:p=Number.POSITIVE_INFINITY,is2D:C=!1,sliceAxis:b=0,penValue:N=1}=s,{dimX:y,dimY:g,dimZ:x}=o,O=y*g*x,[M,I,A]=t;if(M<0||I<0||A<0||M>=y||I>=g||A>=x)return{filledCount:0,seedIntensity:0,intensityMin:0,intensityMax:0};const E=lt(M,I,A,o,i),d=Number(r[E]);let w,m,v;if(s.intensityMin!==void 0&&s.intensityMax!==void 0)w=s.intensityMin,m=s.intensityMax;else{let L=c==="auto"?"symmetric":c;switch(c==="auto"&&(v=d>(a+u)*.5,L=v?"bright":"dark"),L){case"percent":{const S=d===0?.01:d;w=S*(1-f),m=S*(1+f);break}case"bright":if(f>0){const S=d===0?.01:d;w=S*(1-f),m=S*(1+f)}else l>0?(w=d,m=d+l):(w=d,m=Number.POSITIVE_INFINITY);break;case"dark":if(f>0){const S=d===0?.01:d;w=S*(1-f),m=S*(1+f)}else l>0?(w=d-l,m=d):(w=Number.NEGATIVE_INFINITY,m=d);break;default:w=d-l,m=d+l;break}}const nt=ut(h),Z=n?n[0]:1,F=n?n[1]:1,et=n?n[2]:1,D=p*p;function ot(L,S,H){if(!Number.isFinite(D))return!0;const P=(L-M)*Z,q=(S-I)*F,$=(H-A)*et;return P*P+q*q+$*$<=D}let z=-1,G=-1;C&&(b===0?(z=2,G=A):b===1?(z=1,G=I):b===2&&(z=0,G=M));const it=new Uint8Array(O),yt=k(M,I,A,o);if(d<w||d>m)return{filledCount:0,seedIntensity:d,intensityMin:w,intensityMax:m,isBright:v};const rt=[yt];it[yt]=1;let gt=0;for(;rt.length>0;){const L=rt.shift(),S=Math.floor(L/(y*g)),H=Math.floor((L-S*y*g)/y),P=L-S*y*g-H*y;e[L]=N,gt++;for(const[q,$,St]of nt){const B=P+q,W=H+$,T=S+St;if(B<0||W<0||T<0||B>=y||W>=g||T>=x||z>=0&&(z===0?B:z===1?W:T)!==G)continue;const st=k(B,W,T,o);if(it[st]||(it[st]=1,!ot(B,W,T)))continue;const At=Number(r[lt(B,W,T,o,i)]);At<w||At>m||rt.push(st)}}return{filledCount:gt,seedIntensity:d,intensityMin:w,intensityMax:m,isBright:v}}function It(t,e,o,r,s=6){const{dimX:i,dimY:n,dimZ:l}=o,[c,f,a]=t;if(c<0||f<0||a<0||c>=i||f>=n||a>=l)return 0;const u=k(c,f,a,o),h=e[u];if(h===r||h===0)return 0;const p=i*n*l,C=new Uint8Array(p),b=ut(s),N=[u];C[u]=1;let y=0;for(;N.length>0;){const g=N.shift();e[g]=r,y++;const x=Math.floor(g/(i*n)),O=Math.floor((g-x*i*n)/i),M=g-x*i*n-O*i;for(const[I,A,E]of b){const d=M+I,w=O+A,m=x+E;if(d<0||w<0||m<0||d>=i||w>=n||m>=l)continue;const v=k(d,w,m,o);C[v]||(C[v]=1,e[v]===h&&N.push(v))}}return y}const R=self.postMessage.bind(self),Ft={findBoundarySlices(t){const e=t.sliceType,o=new Uint8Array(t.drawBitmap),r=t.dims;return{result:bt(e,o,r)}},interpolateMaskSlices(t){const e=new Uint8Array(t.drawBitmap),o=t.dims,r=t.imageData?new Float32Array(t.imageData):null,s=t.maxVal??1,i=t.sliceIndexLow,n=t.sliceIndexHigh,l=t.options??{},c=t.rasMap??void 0;return{drawBitmap:xt(e,o,r,s,i,n,l,c).buffer}},magicWand(t){const e=t.seed,o=new Uint8Array(t.drawBitmap),r=t.dims,s=new Float32Array(t.imageData),i=t.options??{},n=t.rasMap??void 0,l=t.voxelSizeMM??void 0,c=dt(e,o,r,s,i,n,l);return{drawBitmap:o.buffer,result:c}},magicWandFromBitmap(t){const e=t.seed,o=new Uint8Array(t.drawBitmap),r=t.dims,s=t.newColor??0,i=t.connectivity??6,n=It(e,o,r,s,i);return{drawBitmap:o.buffer,count:n}}};let V=null,Q=null,_=null,tt=null,mt,ht;self.onmessage=t=>{const e=t.data;if(e.type==="initShared"){V=new Uint8Array(e.workingBuffer),Q=new Float32Array(e.imageBuffer),_=new Uint8Array(e.committedBuffer),tt=e.dims,mt=e.rasMap??void 0,ht=e.voxelSizeMM??void 0,R({type:"initSharedDone"});return}if(e.type==="updateCommitted"){_=new Uint8Array(e.committed);return}if(e.type==="magicWandShared"){if(!V||!Q||!_||!tt){R({type:"magicWandSharedResult",error:"Not initialized",gen:e.gen});return}V.set(_);const n=dt(e.seed,V,tt,Q,e.options??{},mt,ht);R({type:"magicWandSharedResult",result:n,gen:e.gen});return}const{_wbId:o,name:r,...s}=e,i=Ft[r];if(!i){R({_wbId:o,_wbError:`Unknown operation: ${r}`});return}try{const n=i(s),l=[];for(const c of Object.values(n))c instanceof ArrayBuffer&&l.push(c);R({_wbId:o,...n},l)}catch(n){R({_wbId:o,_wbError:n instanceof Error?n.message:String(n)})}}})();\n', vn = typeof self < "u" && self.Blob && new Blob([Zn], { type: "text/javascript;charset=utf-8" });
function qa(e) {
  let t;
  try {
    if (t = vn && (self.URL || self.webkitURL).createObjectURL(vn), !t) throw "";
    const n = new Worker(t, {
      name: e == null ? void 0 : e.name
    });
    return n.addEventListener("error", () => {
      (self.URL || self.webkitURL).revokeObjectURL(t);
    }), n;
  } catch {
    return new Worker(
      "data:text/javascript;charset=utf-8," + encodeURIComponent(Zn),
      {
        name: e == null ? void 0 : e.name
      }
    );
  } finally {
    t && (self.URL || self.webkitURL).revokeObjectURL(t);
  }
}
function Ja(e) {
  if (e instanceof Float32Array) return e;
  const t = new Float32Array(e.length);
  for (let n = 0; n < e.length; n++) t[n] = e[n];
  return t;
}
let _t = null;
function Za() {
  return _t || (_t = new va(() => new qa())), _t;
}
async function Qn(e, t, n, o, r, s) {
  const i = t.buffer.slice(
    t.byteOffset,
    t.byteOffset + t.byteLength
  ), l = Ja(o), c = l.buffer.slice(
    l.byteOffset,
    l.byteOffset + l.byteLength
  ), u = [i, c], d = await Za().execute(
    {
      name: "magicWand",
      seed: e,
      drawBitmap: i,
      dims: n,
      imageData: c,
      options: r ?? {},
      rasMap: null,
      voxelSizeMM: s ?? null
    },
    u
  );
  return { bitmap: new Uint8Array(d.drawBitmap), result: d.result };
}
function eo(e, t, n) {
  return {
    thresholdMode: "auto",
    // bright/dark auto-picked around the seed via calMin/calMax
    percent: e.magicWandThresholdPercent,
    // == old clickToSegmentPercent
    calMin: t.calMin,
    calMax: t.calMax,
    maxDistanceMM: e.magicWandMaxDistanceMM,
    is2D: e.magicWand2dOnly,
    sliceAxis: n,
    // 0/1/2 axial/coronal/sagittal, matches sliceType
    penValue: e.penValue
    // wand writes the current pen value
  };
}
async function Qa(e, t, n, o) {
  const r = e.backgroundVolume, s = e.drawing;
  if (!(r != null && r.imgRAS) || !s) return;
  const { bitmap: i } = await Qn(
    n,
    s.bitmap,
    s.dims,
    r.imgRAS,
    eo(t, r, o),
    s.voxelSizeMM
  );
  s.pushUndo(), s.update(i);
}
function es(e) {
  const t = le(null), n = le(!1), o = le(null), r = le(0);
  oe(() => {
    const s = e.current;
    if (!s) return;
    const i = s.createExtensionContext(), l = () => A.getState().drawingOptions, c = async (S, b) => {
      const v = i.drawing, h = i.backgroundVolume;
      if (!v || !(h != null && h.imgRAS)) return;
      t.current == null && (t.current = v.bitmap.slice());
      const g = r.current, { bitmap: N } = await Qn(
        S,
        t.current,
        // magicWand copies its buffer, so this stays intact
        v.dims,
        h.imgRAS,
        eo(l(), h, b),
        v.voxelSizeMM
      );
      g === r.current && v.update(N);
    }, u = () => {
      if (n.current) return;
      const S = o.current;
      S && (o.current = null, n.current = !0, c(S.seed, S.sliceType).finally(() => {
        n.current = !1, u();
      }));
    }, d = (S) => {
      var b;
      l().mode === "wand" && (!i.drawing || !((b = i.backgroundVolume) != null && b.imgRAS) || (o.current = {
        seed: S.detail.voxel,
        sliceType: S.detail.sliceType
      }, u()));
    }, f = () => {
      var S;
      r.current++, o.current = null, t.current != null && ((S = i.drawing) == null || S.update(t.current), t.current = null);
    }, m = (S) => {
      var b;
      if (l().mode === "wand" && !(!i.drawing || !((b = i.backgroundVolume) != null && b.imgRAS)))
        if (o.current = null, t.current != null) {
          const v = i.drawing, h = v.bitmap.slice();
          v.update(t.current), v.pushUndo(), v.update(h), t.current = null;
        } else n.current || (n.current = !0, Qa(
          i,
          l(),
          S.detail.voxel,
          S.detail.sliceType
        ).finally(() => {
          n.current = !1;
        }));
    }, w = (S) => {
      var b;
      ((b = S.detail) == null ? void 0 : b.action) !== "update" && (r.current++, t.current = null);
    };
    return i.on("slicePointerMove", d), i.on("slicePointerUp", m), i.on("slicePointerLeave", f), i.on("drawingChanged", w), () => i.dispose();
  }, [e]);
}
function ts(e, t) {
  const n = e.volumes;
  return Array.isArray(n) && n.forEach((o, r) => {
    if (typeof o != "object" || o === null || Array.isArray(o)) return;
    const s = t[r];
    if (s == null) return;
    const i = o;
    delete i.data, i.url = s;
  }), e;
}
let $e = null, Ge = null;
function to() {
  const e = A.getState();
  return e.skipImagingUploadConfirmation ? Promise.resolve(!0) : ($e && ($e(!1), $e = null), new Promise((t) => {
    $e = t, e.setImagingUploadConfirmDialogOpen(!0);
  }));
}
function bn(e) {
  A.getState().setImagingUploadConfirmDialogOpen(!1);
  const t = $e;
  $e = null, t && t(e);
}
function ns() {
  const e = A.getState();
  return e.skipSessionDeleteConfirmation ? Promise.resolve(!0) : (Ge && (Ge(!1), Ge = null), new Promise((t) => {
    Ge = t, e.setSessionDeleteConfirmDialogOpen(!0);
  }));
}
function wn(e) {
  A.getState().setSessionDeleteConfirmDialogOpen(!1);
  const t = Ge;
  Ge = null, t && t(e);
}
const os = {
  placeholderText: "Drag-drop images",
  isDragDropEnabled: !0,
  backgroundColor: [0, 0, 0, 1],
  crosshairColor: [1, 0, 0, 0.5]
}, Lt = {
  neverSave: ["volume.matcap"]
};
function nu(e = {}) {
  return new ba({ ...os, ...e });
}
function yn(e, t) {
  return e.toLowerCase().endsWith(t) ? e : e + t;
}
function xn(e, t, n) {
  const o = new Blob([e], { type: n }), r = URL.createObjectURL(o), s = document.createElement("a");
  s.href = r, s.download = t, document.body.appendChild(s), s.click(), document.body.removeChild(s), URL.revokeObjectURL(r);
}
function rs(e) {
  const t = A((m) => m.setSaveDialogOpen), n = A((m) => m.saveState), o = A((m) => m.setSaveState), r = I(
    async (m = !1) => {
      if (!e.current || !m && e.current.volumes.length > 0 && !await to())
        return;
      const w = e.current.volumes.map((S) => {
        const b = !!(S.url && S.url.startsWith("http"));
        return {
          enabled: !b,
          isExternal: b,
          url: m ? S.name || "" : S.url || ""
        };
      });
      o({
        isDownloadMode: m,
        document: {
          enabled: !1,
          location: "",
          format: "json"
        },
        volumes: w
      }), t(!0);
    },
    [e, o, t]
  ), s = I(async () => {
    if (console.log("Saving scene to:", n.document.location), !!e.current) {
      if (n.isDownloadMode) {
        if (n.document.enabled && n.document.location.trim())
          try {
            const m = yn(n.document.location.trim(), ".nvd"), w = n.document.format, S = e.current.serializeDocument({
              format: w,
              settings: Lt
            });
            xn(
              S,
              m,
              w === "json" ? "application/json" : "application/cbor"
            );
          } catch (m) {
            console.error("Error downloading document:", m);
          }
        for (let m = 0; m < n.volumes.length; m++) {
          const w = n.volumes[m];
          if (w.enabled && e.current && e.current.volumes[m]) {
            const S = yn(
              w.url || `volume_${m + 1}.nii.gz`,
              ".nii.gz"
            );
            try {
              const b = await e.current.saveVolume({
                filename: "",
                volumeByIndex: m
              });
              if (!(b instanceof Uint8Array))
                throw new Error("saveVolume did not return bytes");
              const v = await bt(b);
              xn(v, S, "application/octet-stream");
            } catch (b) {
              console.error(`Error downloading volume ${m}:`, b);
            }
          }
        }
      } else {
        if (n.document.enabled && n.document.location.trim())
          try {
            const w = n.volumes.map(
              (h) => h.url && h.url.trim() ? h.url : null
            ), S = n.document.format;
            let b;
            if (S === "cbor")
              b = vt(
                e.current.serializeDocument({
                  linkData: !0,
                  settings: Lt
                })
              );
            else {
              const h = new TextDecoder().decode(
                e.current.serializeDocument({
                  format: "json",
                  linkData: !0,
                  settings: Lt
                })
              );
              b = ts(
                JSON.parse(h),
                w
              );
            }
            const v = await fetch(fe("nvd"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                filename: n.document.location,
                data: b,
                format: S
              })
            });
            if (!v.ok)
              throw new Error(`Failed to save document: ${v.statusText}`);
            console.log("Document saved:", await v.json());
          } catch (w) {
            console.error("Error saving document:", w);
          }
        const m = n.volumes.map(
          async (w, S) => {
            if (w.enabled && e.current && e.current.volumes[S]) {
              if (!w.url || w.url.trim() === "") {
                console.log(`Skipping volume ${S}: no URL specified`);
                return;
              }
              try {
                const b = await e.current.saveVolume({
                  filename: "",
                  volumeByIndex: S
                });
                if (!(b instanceof Uint8Array))
                  throw new Error("saveVolume did not return bytes");
                const v = await bt(b), h = vt(v), g = await fetch(fe("nii"), {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json"
                  },
                  body: JSON.stringify({
                    filename: w.url,
                    data: h
                  })
                });
                if (!g.ok)
                  throw new Error(
                    `Failed to save volume ${S}: ${g.statusText}`
                  );
                const N = await g.json();
                console.log(`Volume ${S} saved successfully:`, N);
              } catch (b) {
                console.error(`Error saving volume ${S}:`, b);
              }
            }
          }
        );
        await Promise.all(m);
      }
      t(!1), o({
        isDownloadMode: !1,
        document: {
          enabled: !1,
          location: "",
          format: "json"
        },
        volumes: []
      });
    }
  }, [e, n, t, o]), i = I(() => {
    t(!1), o({
      isDownloadMode: !1,
      document: {
        enabled: !1,
        location: "",
        format: "json"
      },
      volumes: []
    });
  }, [t, o]), l = I(
    (m, w) => {
      o((S) => ({
        ...S,
        volumes: S.volumes.map(
          (b, v) => v === m ? { ...b, url: w } : b
        )
      }));
    },
    [o]
  ), c = I(
    (m, w) => {
      o((S) => ({
        ...S,
        volumes: S.volumes.map((b, v) => v === m ? w && b.isExternal ? { ...b, enabled: w, url: "" } : { ...b, enabled: w } : b)
      }));
    },
    [o]
  ), u = I(
    (m) => {
      o((w) => ({
        ...w,
        document: {
          ...w.document,
          location: m
        }
      }));
    },
    [o]
  ), d = I(
    (m) => {
      o((w) => ({
        ...w,
        document: {
          ...w.document,
          enabled: m
        }
      }));
    },
    [o]
  ), f = I(
    (m) => {
      o((w) => ({
        ...w,
        document: {
          ...w.document,
          format: m
        }
      }));
    },
    [o]
  );
  return {
    handleSaveScene: r,
    handleConfirmSave: s,
    handleCancelSave: i,
    handleVolumeUrlChange: l,
    handleVolumeCheckboxChange: c,
    handleDocumentLocationChange: u,
    handleDocumentCheckboxChange: d,
    handleDocumentFormatChange: f
  };
}
const Cn = "This .nvd predates the niivue document schema (it has `imageOptionsArray` and no `version`). Regenerate it with scripts/migrate-nvd.py.";
function Sn(e) {
  if (e instanceof Uint8Array) {
    if (e.find(
      (r) => r !== 32 && r !== 9 && r !== 10 && r !== 13
    ) !== 123) return;
    const n = new TextDecoder("utf-8", { fatal: !1 }).decode(
      e.subarray(0, 64 * 1024)
    );
    if ((n.includes('"imageOptionsArray"') || n.includes('"encodedImageBlobs"')) && !n.includes('"version"'))
      throw new Error(Cn);
    return;
  }
  if (("imageOptionsArray" in e || "encodedImageBlobs" in e) && typeof e.version != "number")
    throw new Error(Cn);
}
function as(e, t, n, o) {
  const r = A((x) => x.showUploader), s = A((x) => x.setShowUploader), i = A((x) => x.currentImageIndex), l = A(
    (x) => x.setCurrentImageIndex
  ), c = A((x) => x.volumeVersion), u = A(
    (x) => x.incrementVolumeVersion
  ), d = A((x) => x.currentSurfaceIndex), f = A(
    (x) => x.setCurrentSurfaceIndex
  ), m = A((x) => x.setActiveTab), w = wt.serverless, S = le(null), b = le(null), v = I(
    async (x) => {
      const M = e.current;
      if (!M) return;
      let V;
      if (x instanceof ArrayBuffer || x instanceof Uint8Array) {
        const R = x instanceof Uint8Array ? x : new Uint8Array(x);
        Sn(R), V = new File([R], "scene.nvd", {
          type: "application/octet-stream"
        });
      } else
        Sn(x), V = new File([JSON.stringify(x)], "scene.nvd", {
          type: "application/json"
        });
      await M.loadDocument(V, { fill: "current" }), await ja(M), i === null && M.volumes.length > 0 && l(0), d === null && M.meshes.length > 0 && f(0);
    },
    [
      e,
      n,
      o,
      i,
      d,
      l,
      f
    ]
  ), h = I(
    async (x) => {
      if (!e.current) return;
      const M = e.current;
      r && s(!1);
      let V = 0;
      for (; !M.canvas && V < 20; )
        console.log(
          `Waiting for canvas to be ready for file upload... attempt ${V + 1}`
        ), await new Promise((O) => setTimeout(O, 100)), V++;
      if (!M.canvas)
        throw new Error("Canvas failed to initialize after 2 seconds");
      const R = x.filter(
        (O) => O.name.toLowerCase().endsWith(".nvd") || O.name.toLowerCase().endsWith(".json")
      );
      if (R.length > 0) {
        const O = R[0];
        try {
          const H = await O.arrayBuffer();
          console.log("NVD file loaded:", O.name, H.byteLength, "bytes"), await v(H);
        } catch (H) {
          console.error("Error loading uploaded NVD file:", H);
        }
      } else {
        const O = x.map(async (H) => {
          await M.addVolume({ url: H, name: H.name });
        });
        await Promise.all(O), t(), u(), i === null && x.length > 0 && l(0);
      }
    },
    [
      e,
      r,
      i,
      v,
      t,
      u,
      s,
      l
    ]
  ), g = I(
    async (x) => {
      if (!e.current) return;
      const M = e.current;
      try {
        r && s(!1);
        let V = 0;
        for (; !M.canvas && V < 20; )
          console.log(
            `Waiting for canvas to be ready for imaging file... attempt ${V + 1}`
          ), await new Promise((H) => setTimeout(H, 100)), V++;
        if (!M.canvas)
          throw new Error("Canvas failed to initialize after 2 seconds");
        const R = x.filename.split("/").pop() || x.filename, O = {
          url: x.url,
          name: R
        };
        console.log("Adding imaging file to scene:", O), await M.addVolume(O), t(), u(), M.volumes.length > 0 && l(M.volumes.length - 1), console.log("Imaging file loaded successfully");
      } catch (V) {
        console.error("Error loading imaging file:", V);
      }
    },
    [
      e,
      r,
      t,
      u,
      s,
      l
    ]
  ), N = I(
    async (x) => {
      if (!e.current) return;
      const M = e.current;
      try {
        const V = await fetch(x.url);
        if (!V.ok)
          throw new Error(`HTTP error! status: ${V.status}`);
        const R = await V.arrayBuffer();
        console.log(`NVD fetched from ${x.url}: ${R.byteLength} bytes`), s(!1);
        let O = 0;
        for (; !M.canvas && O < 20; )
          console.log(
            `Waiting for canvas to be ready... attempt ${O + 1}`
          ), await new Promise((H) => setTimeout(H, 100)), O++;
        if (!M.canvas)
          throw new Error("Canvas failed to initialize after 2 seconds");
        await v(R);
      } catch (V) {
        console.error("Error loading NVD:", V);
      }
    },
    [e, v, s]
  ), k = I(
    (x) => {
      if (x.target.files && x.target.files.length > 0) {
        const M = Array.from(x.target.files);
        h(M);
      }
      x.target.value = "";
    },
    [h]
  ), E = I(() => {
    var x;
    (x = S.current) == null || x.click();
  }, []), U = I(() => {
    var x;
    (x = b.current) == null || x.click();
  }, []), F = I(
    async (x) => {
      if (x.target.files && x.target.files.length > 0 && e.current) {
        const M = e.current, V = Array.from(x.target.files);
        r && s(!1);
        let R = 0;
        for (; !M.canvas && R < 20; )
          await new Promise((O) => setTimeout(O, 100)), R++;
        if (!M.canvas) {
          console.error("Canvas failed to initialize for surface upload");
          return;
        }
        try {
          for (const O of V)
            await M.addMesh({
              url: O,
              name: O.name,
              color: [1, 1, 0, 1],
              shaderType: "phong"
            });
        } catch (O) {
          console.error("Error loading surface files:", O);
        }
        d === null && M.meshes.length > 0 && f(M.meshes.length - V.length);
      }
      x.target.value = "";
    },
    [
      e,
      r,
      d,
      s,
      f
    ]
  );
  oe(() => {
    const x = e.current;
    if (!x) return;
    const M = () => {
      requestAnimationFrame(() => u());
    };
    return x.addEventListener("dragRelease", M), () => {
      x.removeEventListener("dragRelease", M);
    };
  }, [e, u]);
  const C = A((x) => x.dragDropEnabled);
  return oe(() => {
    var x;
    e.current && (e.current.isDragDropEnabled = C && r && (((x = e.current.volumes) == null ? void 0 : x.length) ?? 0) === 0);
  }, [e, c, r, C]), oe(() => {
    w && m("sceneDetails");
  }, [w, m]), oe(() => {
    if (!je().readUrlParams) return;
    const M = new URLSearchParams(window.location.search).get("nvd");
    if (M) {
      console.log("Loading NVD from URL parameter:", M);
      const V = {
        filename: M.split("/").pop() || M,
        url: M
      };
      N(V);
    }
  }, []), oe(() => {
    if (!je().readUrlParams) return;
    const M = new URLSearchParams(window.location.search).get("vol");
    if (M) {
      console.log("Loading volume from URL parameter:", M);
      const R = { filename: M.split("/").pop() || M, url: M };
      g(R);
    }
  }, []), oe(() => {
    const x = async (M) => {
      if (!M.detail || !e.current || window.__EMBEDDED_NVD_LOADED__) return;
      window.__EMBEDDED_NVD_LOADED__ = !0, console.log("Loading embedded NVD data"), s(!1);
      let V = 0;
      for (; !e.current.canvas && V < 20; )
        await new Promise((R) => setTimeout(R, 100)), V++;
      e.current.canvas && await v(M.detail);
    };
    return window.addEventListener(
      "loadEmbeddedNvd",
      x
    ), window.__EMBEDDED_NVD_DATA__ && !window.__EMBEDDED_NVD_LOADED__ && window.dispatchEvent(
      new CustomEvent("loadEmbeddedNvd", {
        detail: window.__EMBEDDED_NVD_DATA__
      })
    ), () => window.removeEventListener(
      "loadEmbeddedNvd",
      x
    );
  }, []), {
    serverlessMode: w,
    fileInputRef: S,
    surfaceFileInputRef: b,
    loadNvdData: v,
    handleFileUpload: h,
    handleImagingFileSelect: g,
    handleNvdFileSelect: N,
    handleFileChange: k,
    handleAddMoreFiles: E,
    handleAddSurfaceFiles: U,
    handleSurfaceFileChange: F
  };
}
function ss() {
  const e = A((t) => t.setAiEnabled);
  oe(() => {
    if (wt.serverless) {
      e(!1);
      return;
    }
    let t = !1;
    return (async () => {
      try {
        const n = await fetch(Me("model/list"));
        if (!n.ok) {
          t || e(!1);
          return;
        }
        const o = await n.json();
        if (t) return;
        e(Array.isArray(o) && o.length > 0);
      } catch {
        t || e(!1);
      }
    })(), () => {
      t = !0;
    };
  }, [e]);
}
const is = /^[A-Za-z0-9_-]+$/;
async function ls() {
  const e = await fetch(Me("session/list"));
  if (!e.ok) throw new Error(`GET /ai/session/list failed: ${e.status}`);
  return e.json();
}
function cs(e) {
  return e ? e.endsWith(".nii.gz") || e.endsWith(".nii") ? e : `${e}.nii.gz` : "volume.nii.gz";
}
function ds(e) {
  return Ia(e);
}
async function us(e) {
  const t = await fetch(e);
  if (!t.ok) throw new Error(`GET ${e} failed: ${t.status}`);
  return new Uint8Array(await t.arrayBuffer());
}
async function kn(e, t) {
  if (!e.drawingVolume || e.volumes.length === 0) return null;
  const n = await e.saveVolume({
    filename: "",
    isSaveDrawing: !0,
    volumeByIndex: 0
  });
  if (!(n instanceof Uint8Array)) return null;
  const o = await bt(n), r = "annotations.nii.gz", s = `ai-sessions/${t}/${r}`, i = await fetch(fe("nii"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: s,
      data: vt(o)
    })
  });
  if (!i.ok)
    throw new Error(
      `annotations upload failed: ${i.status} ${i.statusText}`
    );
  return r;
}
async function Nn(e, t) {
  const n = await fetch(
    Me(`session/${encodeURIComponent(e)}/set_annots`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotation_path: t })
    }
  );
  if (!n.ok) {
    const o = await n.text();
    throw new Error(`set_annots failed (${n.status}): ${o}`);
  }
}
const ut = "result.nii.gz", An = "sky_blue", ms = {
  R: [0, 91, 91],
  G: [0, 163, 163],
  B: [0, 201, 201],
  A: [0, 64, 128],
  I: [0, 128, 255]
}, fs = {
  R: [0, 0, 255],
  G: [0, 255, 0],
  B: [0, 0, 0],
  A: [0, 255, 255],
  I: [0, 1, 2],
  labels: ["background", "positive", "negative"]
};
function hs(e) {
  const t = A((g) => g.aiEnabled), n = A((g) => g.setAiSessions), o = A((g) => g.setAiActiveSession), r = A((g) => g.aiActiveSession), s = A((g) => g.drawingOptions), i = A((g) => g.setDrawingOptions), l = A((g) => g.setActiveTab), c = A((g) => g.setShowUploader), u = A(
    (g) => g.incrementVolumeVersion
  ), d = I(async () => {
    try {
      const g = await ls();
      n(g);
    } catch (g) {
      console.error("Failed to refresh AI sessions:", g);
    }
  }, [n]);
  oe(() => {
    t && d();
  }, [t, d]);
  const f = I(() => {
    const g = e.current;
    if (!g) return;
    const N = s.penValue === 2 ? 2 : 1;
    g.drawingVolume || g.createEmptyDrawing(), g.addColormap("ai_prompt", fs), g.drawColormap = "ai_prompt", g.drawPenValue = N, g.drawOpacity = 1, g.drawIsEnabled = !1, i((k) => ({
      ...k,
      enabled: !0,
      mode: "none",
      opacity: 1,
      penValue: N
    })), l("aiAnnotation");
  }, [
    e,
    s.penValue,
    i,
    l
  ]), m = I(() => {
    const g = e.current;
    g && (g.drawIsEnabled = !1, g.closeDrawing()), i((N) => ({ ...N, enabled: !1, mode: "none" })), o(null), u();
  }, [e, i, o, u]), w = I(
    async (g) => {
      const N = g.trim();
      if (!N) throw new Error("Session name is required");
      if (!is.test(N))
        throw new Error(
          "Session name may only contain letters, digits, underscores, and hyphens"
        );
      const k = e.current;
      if (!k || k.volumes.length === 0)
        throw new Error("Load a volume before creating a session");
      const E = k.volumes[0], U = typeof E.url == "string" ? ds(E.url) : null, F = !U;
      if (F && !await to())
        throw new Error("Upload cancelled");
      const C = await fetch(Me("session/new"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_name: N })
      });
      if (!C.ok) {
        const O = await C.text();
        throw new Error(`Create session failed (${C.status}): ${O}`);
      }
      const { session_id: x, session_name: M } = await C.json();
      let V;
      if (F) {
        const O = cs(E.name), H = `ai-sessions/${N}/${O}`, D = await k.saveVolume({ filename: "", volumeByIndex: 0 }), P = D instanceof Uint8Array ? await bt(D) : new Uint8Array(), W = vt(P), T = await fetch(fe("nii"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: H, data: W })
        });
        if (!T.ok)
          throw new Error(
            `Volume upload failed: ${T.status} ${T.statusText}`
          );
        V = H;
      } else
        V = U;
      const R = await fetch(
        Me(`session/${encodeURIComponent(x)}/set_volume`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volume_path: V })
        }
      );
      if (!R.ok) {
        const O = await R.text();
        throw new Error(`set_volume failed (${R.status}): ${O}`);
      }
      o({ session_id: x, session_name: M }), f(), await d();
    },
    [e, o, f, d]
  ), S = I(
    async (g) => {
      const N = e.current;
      if (!N) throw new Error("Viewer not ready");
      const k = A.getState().aiSessions.find((U) => U.session_id === g);
      if (!k) throw new Error(`Unknown session: ${g}`);
      if (!k.volume_path)
        throw new Error("Session has no volume set; cannot load");
      const E = k.volume_path_root === "session" ? fe(`ai-sessions/${k.session_name}/${k.volume_path}`) : fe(k.volume_path);
      if (c(!1), await N.loadVolumes([{ url: E }]), u(), k.annotation_path)
        try {
          const U = fe(
            `ai-sessions/${k.session_name}/${k.annotation_path}`
          ), F = await us(U), C = new File([F], k.annotation_path);
          await N.loadDrawing(C) || console.warn(
            "loadDrawing returned false — annotation dimensions may not match the volume"
          );
        } catch (U) {
          console.error("Failed to load existing annotations:", U);
        }
      o({
        session_id: k.session_id,
        session_name: k.session_name
      }), f();
    },
    [
      e,
      c,
      u,
      o,
      f
    ]
  ), b = I(
    async (g, N) => {
      const k = e.current, E = A.getState().aiActiveSession;
      if (!k || !E || k.volumes.length === 0)
        throw new Error("No active session or volume");
      const U = await kn(k, E.session_name);
      if (!U) throw new Error("No drawing layer to send as annotations");
      await Nn(E.session_id, U);
      const F = await fetch(
        Me(
          `session/${encodeURIComponent(E.session_id)}/infer/${encodeURIComponent(g)}`
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label_value: N })
        }
      );
      if (!F.ok) {
        const M = await F.text();
        throw new Error(`inference failed (${F.status}): ${M}`);
      }
      await F.json();
      const C = k.volumes.length - 1;
      if (C > 0) {
        const M = k.volumes[C], V = typeof (M == null ? void 0 : M.name) == "string" ? M.name : "", R = typeof (M == null ? void 0 : M.url) == "string" ? M.url : "";
        (V === ut || R.includes(`/${ut}`)) && await k.removeVolume(C);
      }
      const x = fe(`ai-sessions/${E.session_name}/${ut}`) + `?t=${Date.now()}`;
      k.addColormap(An, ms), await k.addVolume({
        url: x,
        name: ut,
        colormap: An,
        opacity: 0.5
      }), u();
    },
    [e, u]
  ), v = I(async () => {
    const g = e.current, N = A.getState().aiActiveSession;
    if (g && N)
      try {
        const k = await kn(g, N.session_name);
        k && await Nn(N.session_id, k);
      } catch (k) {
        console.error("Failed to save annotations on exit:", k);
      }
    m();
  }, [e, m]), h = I(async () => {
    if (!r || !await ns()) return;
    const N = r.session_id;
    try {
      const k = await fetch(Me(`session/${encodeURIComponent(N)}`), {
        method: "DELETE"
      });
      if (!k.ok) {
        const E = await k.text();
        console.error(`DELETE session failed (${k.status}): ${E}`);
      }
    } catch (k) {
      console.error("DELETE session error:", k);
    }
    m(), await d();
  }, [r, m, d]);
  return {
    refreshSessions: d,
    handleNewSession: w,
    handleLoadSession: S,
    handleRunSegmentation: b,
    handleExitAndSaveSession: v,
    handleExitAndDeleteSession: h
  };
}
function no(e) {
  var t, n, o = "";
  if (typeof e == "string" || typeof e == "number") o += e;
  else if (typeof e == "object") if (Array.isArray(e)) {
    var r = e.length;
    for (t = 0; t < r; t++) e[t] && (n = no(e[t])) && (o && (o += " "), o += n);
  } else for (n in e) e[n] && (o && (o += " "), o += n);
  return o;
}
function oo() {
  for (var e, t, n = 0, o = "", r = arguments.length; n < r; n++) (e = arguments[n]) && (t = no(e)) && (o && (o += " "), o += t);
  return o;
}
const ps = (e, t) => {
  const n = new Array(e.length + t.length);
  for (let o = 0; o < e.length; o++)
    n[o] = e[o];
  for (let o = 0; o < t.length; o++)
    n[e.length + o] = t[o];
  return n;
}, gs = (e, t) => ({
  classGroupId: e,
  validator: t
}), ro = (e = /* @__PURE__ */ new Map(), t = null, n) => ({
  nextPart: e,
  validators: t,
  classGroupId: n
}), yt = "-", Mn = [], vs = "arbitrary..", bs = (e) => {
  const t = ys(e), {
    conflictingClassGroups: n,
    conflictingClassGroupModifiers: o
  } = e;
  return {
    getClassGroupId: (i) => {
      if (i.startsWith("[") && i.endsWith("]"))
        return ws(i);
      const l = i.split(yt), c = l[0] === "" && l.length > 1 ? 1 : 0;
      return ao(l, c, t);
    },
    getConflictingClassGroupIds: (i, l) => {
      if (l) {
        const c = o[i], u = n[i];
        return c ? u ? ps(u, c) : c : u || Mn;
      }
      return n[i] || Mn;
    }
  };
}, ao = (e, t, n) => {
  if (e.length - t === 0)
    return n.classGroupId;
  const r = e[t], s = n.nextPart.get(r);
  if (s) {
    const u = ao(e, t + 1, s);
    if (u) return u;
  }
  const i = n.validators;
  if (i === null)
    return;
  const l = t === 0 ? e.join(yt) : e.slice(t).join(yt), c = i.length;
  for (let u = 0; u < c; u++) {
    const d = i[u];
    if (d.validator(l))
      return d.classGroupId;
  }
}, ws = (e) => e.slice(1, -1).indexOf(":") === -1 ? void 0 : (() => {
  const t = e.slice(1, -1), n = t.indexOf(":"), o = t.slice(0, n);
  return o ? vs + o : void 0;
})(), ys = (e) => {
  const {
    theme: t,
    classGroups: n
  } = e;
  return xs(n, t);
}, xs = (e, t) => {
  const n = ro();
  for (const o in e) {
    const r = e[o];
    Kt(r, n, o, t);
  }
  return n;
}, Kt = (e, t, n, o) => {
  const r = e.length;
  for (let s = 0; s < r; s++) {
    const i = e[s];
    Cs(i, t, n, o);
  }
}, Cs = (e, t, n, o) => {
  if (typeof e == "string") {
    Ss(e, t, n);
    return;
  }
  if (typeof e == "function") {
    ks(e, t, n, o);
    return;
  }
  Ns(e, t, n, o);
}, Ss = (e, t, n) => {
  const o = e === "" ? t : so(t, e);
  o.classGroupId = n;
}, ks = (e, t, n, o) => {
  if (As(e)) {
    Kt(e(o), t, n, o);
    return;
  }
  t.validators === null && (t.validators = []), t.validators.push(gs(n, e));
}, Ns = (e, t, n, o) => {
  const r = Object.entries(e), s = r.length;
  for (let i = 0; i < s; i++) {
    const [l, c] = r[i];
    Kt(c, so(t, l), n, o);
  }
}, so = (e, t) => {
  let n = e;
  const o = t.split(yt), r = o.length;
  for (let s = 0; s < r; s++) {
    const i = o[s];
    let l = n.nextPart.get(i);
    l || (l = ro(), n.nextPart.set(i, l)), n = l;
  }
  return n;
}, As = (e) => "isThemeGetter" in e && e.isThemeGetter === !0, Ms = (e) => {
  if (e < 1)
    return {
      get: () => {
      },
      set: () => {
      }
    };
  let t = 0, n = /* @__PURE__ */ Object.create(null), o = /* @__PURE__ */ Object.create(null);
  const r = (s, i) => {
    n[s] = i, t++, t > e && (t = 0, o = n, n = /* @__PURE__ */ Object.create(null));
  };
  return {
    get(s) {
      let i = n[s];
      if (i !== void 0)
        return i;
      if ((i = o[s]) !== void 0)
        return r(s, i), i;
    },
    set(s, i) {
      s in n ? n[s] = i : r(s, i);
    }
  };
}, $t = "!", En = ":", Es = [], Dn = (e, t, n, o, r) => ({
  modifiers: e,
  hasImportantModifier: t,
  baseClassName: n,
  maybePostfixModifierPosition: o,
  isExternal: r
}), Ds = (e) => {
  const {
    prefix: t,
    experimentalParseClassName: n
  } = e;
  let o = (r) => {
    const s = [];
    let i = 0, l = 0, c = 0, u;
    const d = r.length;
    for (let b = 0; b < d; b++) {
      const v = r[b];
      if (i === 0 && l === 0) {
        if (v === En) {
          s.push(r.slice(c, b)), c = b + 1;
          continue;
        }
        if (v === "/") {
          u = b;
          continue;
        }
      }
      v === "[" ? i++ : v === "]" ? i-- : v === "(" ? l++ : v === ")" && l--;
    }
    const f = s.length === 0 ? r : r.slice(c);
    let m = f, w = !1;
    f.endsWith($t) ? (m = f.slice(0, -1), w = !0) : (
      /**
       * In Tailwind CSS v3 the important modifier was at the start of the base class name. This is still supported for legacy reasons.
       * @see https://github.com/dcastil/tailwind-merge/issues/513#issuecomment-2614029864
       */
      f.startsWith($t) && (m = f.slice(1), w = !0)
    );
    const S = u && u > c ? u - c : void 0;
    return Dn(s, w, m, S);
  };
  if (t) {
    const r = t + En, s = o;
    o = (i) => i.startsWith(r) ? s(i.slice(r.length)) : Dn(Es, !1, i, void 0, !0);
  }
  if (n) {
    const r = o;
    o = (s) => n({
      className: s,
      parseClassName: r
    });
  }
  return o;
}, Is = (e) => {
  const t = /* @__PURE__ */ new Map();
  return e.orderSensitiveModifiers.forEach((n, o) => {
    t.set(n, 1e6 + o);
  }), (n) => {
    const o = [];
    let r = [];
    for (let s = 0; s < n.length; s++) {
      const i = n[s], l = i[0] === "[", c = t.has(i);
      l || c ? (r.length > 0 && (r.sort(), o.push(...r), r = []), o.push(i)) : r.push(i);
    }
    return r.length > 0 && (r.sort(), o.push(...r)), o;
  };
}, Rs = (e) => ({
  cache: Ms(e.cacheSize),
  parseClassName: Ds(e),
  sortModifiers: Is(e),
  ...bs(e)
}), Ps = /\s+/, Ts = (e, t) => {
  const {
    parseClassName: n,
    getClassGroupId: o,
    getConflictingClassGroupIds: r,
    sortModifiers: s
  } = t, i = [], l = e.trim().split(Ps);
  let c = "";
  for (let u = l.length - 1; u >= 0; u -= 1) {
    const d = l[u], {
      isExternal: f,
      modifiers: m,
      hasImportantModifier: w,
      baseClassName: S,
      maybePostfixModifierPosition: b
    } = n(d);
    if (f) {
      c = d + (c.length > 0 ? " " + c : c);
      continue;
    }
    let v = !!b, h = o(v ? S.substring(0, b) : S);
    if (!h) {
      if (!v) {
        c = d + (c.length > 0 ? " " + c : c);
        continue;
      }
      if (h = o(S), !h) {
        c = d + (c.length > 0 ? " " + c : c);
        continue;
      }
      v = !1;
    }
    const g = m.length === 0 ? "" : m.length === 1 ? m[0] : s(m).join(":"), N = w ? g + $t : g, k = N + h;
    if (i.indexOf(k) > -1)
      continue;
    i.push(k);
    const E = r(h, v);
    for (let U = 0; U < E.length; ++U) {
      const F = E[U];
      i.push(N + F);
    }
    c = d + (c.length > 0 ? " " + c : c);
  }
  return c;
}, Vs = (...e) => {
  let t = 0, n, o, r = "";
  for (; t < e.length; )
    (n = e[t++]) && (o = io(n)) && (r && (r += " "), r += o);
  return r;
}, io = (e) => {
  if (typeof e == "string")
    return e;
  let t, n = "";
  for (let o = 0; o < e.length; o++)
    e[o] && (t = io(e[o])) && (n && (n += " "), n += t);
  return n;
}, Os = (e, ...t) => {
  let n, o, r, s;
  const i = (c) => {
    const u = t.reduce((d, f) => f(d), e());
    return n = Rs(u), o = n.cache.get, r = n.cache.set, s = l, l(c);
  }, l = (c) => {
    const u = o(c);
    if (u)
      return u;
    const d = Ts(c, n);
    return r(c, d), d;
  };
  return s = i, (...c) => s(Vs(...c));
}, _s = [], ne = (e) => {
  const t = (n) => n[e] || _s;
  return t.isThemeGetter = !0, t;
}, lo = /^\[(?:(\w[\w-]*):)?(.+)\]$/i, co = /^\((?:(\w[\w-]*):)?(.+)\)$/i, Ls = /^\d+\/\d+$/, Fs = /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/, Us = /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^0$/, zs = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix)\(.+\)$/, Ws = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/, Bs = /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/, ze = (e) => Ls.test(e), $ = (e) => !!e && !Number.isNaN(Number(e)), Ne = (e) => !!e && Number.isInteger(Number(e)), Ft = (e) => e.endsWith("%") && $(e.slice(0, -1)), ge = (e) => Fs.test(e), $s = () => !0, Gs = (e) => (
  // `colorFunctionRegex` check is necessary because color functions can have percentages in them which which would be incorrectly classified as lengths.
  // For example, `hsl(0 0% 0%)` would be classified as a length without this check.
  // I could also use lookbehind assertion in `lengthUnitRegex` but that isn't supported widely enough.
  Us.test(e) && !zs.test(e)
), uo = () => !1, js = (e) => Ws.test(e), Hs = (e) => Bs.test(e), Ys = (e) => !_(e) && !L(e), Xs = (e) => Xe(e, ho, uo), _ = (e) => lo.test(e), Oe = (e) => Xe(e, po, Gs), Ut = (e) => Xe(e, Qs, $), In = (e) => Xe(e, mo, uo), Ks = (e) => Xe(e, fo, Hs), mt = (e) => Xe(e, go, js), L = (e) => co.test(e), rt = (e) => Ke(e, po), qs = (e) => Ke(e, ei), Rn = (e) => Ke(e, mo), Js = (e) => Ke(e, ho), Zs = (e) => Ke(e, fo), ft = (e) => Ke(e, go, !0), Xe = (e, t, n) => {
  const o = lo.exec(e);
  return o ? o[1] ? t(o[1]) : n(o[2]) : !1;
}, Ke = (e, t, n = !1) => {
  const o = co.exec(e);
  return o ? o[1] ? t(o[1]) : n : !1;
}, mo = (e) => e === "position" || e === "percentage", fo = (e) => e === "image" || e === "url", ho = (e) => e === "length" || e === "size" || e === "bg-size", po = (e) => e === "length", Qs = (e) => e === "number", ei = (e) => e === "family-name", go = (e) => e === "shadow", ti = () => {
  const e = ne("color"), t = ne("font"), n = ne("text"), o = ne("font-weight"), r = ne("tracking"), s = ne("leading"), i = ne("breakpoint"), l = ne("container"), c = ne("spacing"), u = ne("radius"), d = ne("shadow"), f = ne("inset-shadow"), m = ne("text-shadow"), w = ne("drop-shadow"), S = ne("blur"), b = ne("perspective"), v = ne("aspect"), h = ne("ease"), g = ne("animate"), N = () => ["auto", "avoid", "all", "avoid-page", "page", "left", "right", "column"], k = () => [
    "center",
    "top",
    "bottom",
    "left",
    "right",
    "top-left",
    // Deprecated since Tailwind CSS v4.1.0, see https://github.com/tailwindlabs/tailwindcss/pull/17378
    "left-top",
    "top-right",
    // Deprecated since Tailwind CSS v4.1.0, see https://github.com/tailwindlabs/tailwindcss/pull/17378
    "right-top",
    "bottom-right",
    // Deprecated since Tailwind CSS v4.1.0, see https://github.com/tailwindlabs/tailwindcss/pull/17378
    "right-bottom",
    "bottom-left",
    // Deprecated since Tailwind CSS v4.1.0, see https://github.com/tailwindlabs/tailwindcss/pull/17378
    "left-bottom"
  ], E = () => [...k(), L, _], U = () => ["auto", "hidden", "clip", "visible", "scroll"], F = () => ["auto", "contain", "none"], C = () => [L, _, c], x = () => [ze, "full", "auto", ...C()], M = () => [Ne, "none", "subgrid", L, _], V = () => ["auto", {
    span: ["full", Ne, L, _]
  }, Ne, L, _], R = () => [Ne, "auto", L, _], O = () => ["auto", "min", "max", "fr", L, _], H = () => ["start", "end", "center", "between", "around", "evenly", "stretch", "baseline", "center-safe", "end-safe"], D = () => ["start", "end", "center", "stretch", "center-safe", "end-safe"], P = () => ["auto", ...C()], W = () => [ze, "auto", "full", "dvw", "dvh", "lvw", "lvh", "svw", "svh", "min", "max", "fit", ...C()], T = () => [e, L, _], re = () => [...k(), Rn, In, {
    position: [L, _]
  }], ae = () => ["no-repeat", {
    repeat: ["", "x", "y", "space", "round"]
  }], de = () => ["auto", "cover", "contain", Js, Xs, {
    size: [L, _]
  }], ie = () => [Ft, rt, Oe], q = () => [
    // Deprecated since Tailwind CSS v4.0.0
    "",
    "none",
    "full",
    u,
    L,
    _
  ], Z = () => ["", $, rt, Oe], me = () => ["solid", "dashed", "dotted", "double"], ye = () => ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"], J = () => [$, Ft, Rn, In], Fe = () => [
    // Deprecated since Tailwind CSS v4.0.0
    "",
    "none",
    S,
    L,
    _
  ], xe = () => ["none", $, L, _], Ce = () => ["none", $, L, _], Se = () => [$, L, _], Ve = () => [ze, "full", ...C()];
  return {
    cacheSize: 500,
    theme: {
      animate: ["spin", "ping", "pulse", "bounce"],
      aspect: ["video"],
      blur: [ge],
      breakpoint: [ge],
      color: [$s],
      container: [ge],
      "drop-shadow": [ge],
      ease: ["in", "out", "in-out"],
      font: [Ys],
      "font-weight": ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"],
      "inset-shadow": [ge],
      leading: ["none", "tight", "snug", "normal", "relaxed", "loose"],
      perspective: ["dramatic", "near", "normal", "midrange", "distant", "none"],
      radius: [ge],
      shadow: [ge],
      spacing: ["px", $],
      text: [ge],
      "text-shadow": [ge],
      tracking: ["tighter", "tight", "normal", "wide", "wider", "widest"]
    },
    classGroups: {
      // --------------
      // --- Layout ---
      // --------------
      /**
       * Aspect Ratio
       * @see https://tailwindcss.com/docs/aspect-ratio
       */
      aspect: [{
        aspect: ["auto", "square", ze, _, L, v]
      }],
      /**
       * Container
       * @see https://tailwindcss.com/docs/container
       * @deprecated since Tailwind CSS v4.0.0
       */
      container: ["container"],
      /**
       * Columns
       * @see https://tailwindcss.com/docs/columns
       */
      columns: [{
        columns: [$, _, L, l]
      }],
      /**
       * Break After
       * @see https://tailwindcss.com/docs/break-after
       */
      "break-after": [{
        "break-after": N()
      }],
      /**
       * Break Before
       * @see https://tailwindcss.com/docs/break-before
       */
      "break-before": [{
        "break-before": N()
      }],
      /**
       * Break Inside
       * @see https://tailwindcss.com/docs/break-inside
       */
      "break-inside": [{
        "break-inside": ["auto", "avoid", "avoid-page", "avoid-column"]
      }],
      /**
       * Box Decoration Break
       * @see https://tailwindcss.com/docs/box-decoration-break
       */
      "box-decoration": [{
        "box-decoration": ["slice", "clone"]
      }],
      /**
       * Box Sizing
       * @see https://tailwindcss.com/docs/box-sizing
       */
      box: [{
        box: ["border", "content"]
      }],
      /**
       * Display
       * @see https://tailwindcss.com/docs/display
       */
      display: ["block", "inline-block", "inline", "flex", "inline-flex", "table", "inline-table", "table-caption", "table-cell", "table-column", "table-column-group", "table-footer-group", "table-header-group", "table-row-group", "table-row", "flow-root", "grid", "inline-grid", "contents", "list-item", "hidden"],
      /**
       * Screen Reader Only
       * @see https://tailwindcss.com/docs/display#screen-reader-only
       */
      sr: ["sr-only", "not-sr-only"],
      /**
       * Floats
       * @see https://tailwindcss.com/docs/float
       */
      float: [{
        float: ["right", "left", "none", "start", "end"]
      }],
      /**
       * Clear
       * @see https://tailwindcss.com/docs/clear
       */
      clear: [{
        clear: ["left", "right", "both", "none", "start", "end"]
      }],
      /**
       * Isolation
       * @see https://tailwindcss.com/docs/isolation
       */
      isolation: ["isolate", "isolation-auto"],
      /**
       * Object Fit
       * @see https://tailwindcss.com/docs/object-fit
       */
      "object-fit": [{
        object: ["contain", "cover", "fill", "none", "scale-down"]
      }],
      /**
       * Object Position
       * @see https://tailwindcss.com/docs/object-position
       */
      "object-position": [{
        object: E()
      }],
      /**
       * Overflow
       * @see https://tailwindcss.com/docs/overflow
       */
      overflow: [{
        overflow: U()
      }],
      /**
       * Overflow X
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-x": [{
        "overflow-x": U()
      }],
      /**
       * Overflow Y
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-y": [{
        "overflow-y": U()
      }],
      /**
       * Overscroll Behavior
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      overscroll: [{
        overscroll: F()
      }],
      /**
       * Overscroll Behavior X
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-x": [{
        "overscroll-x": F()
      }],
      /**
       * Overscroll Behavior Y
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-y": [{
        "overscroll-y": F()
      }],
      /**
       * Position
       * @see https://tailwindcss.com/docs/position
       */
      position: ["static", "fixed", "absolute", "relative", "sticky"],
      /**
       * Top / Right / Bottom / Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      inset: [{
        inset: x()
      }],
      /**
       * Right / Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-x": [{
        "inset-x": x()
      }],
      /**
       * Top / Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-y": [{
        "inset-y": x()
      }],
      /**
       * Start
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      start: [{
        start: x()
      }],
      /**
       * End
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      end: [{
        end: x()
      }],
      /**
       * Top
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      top: [{
        top: x()
      }],
      /**
       * Right
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      right: [{
        right: x()
      }],
      /**
       * Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      bottom: [{
        bottom: x()
      }],
      /**
       * Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      left: [{
        left: x()
      }],
      /**
       * Visibility
       * @see https://tailwindcss.com/docs/visibility
       */
      visibility: ["visible", "invisible", "collapse"],
      /**
       * Z-Index
       * @see https://tailwindcss.com/docs/z-index
       */
      z: [{
        z: [Ne, "auto", L, _]
      }],
      // ------------------------
      // --- Flexbox and Grid ---
      // ------------------------
      /**
       * Flex Basis
       * @see https://tailwindcss.com/docs/flex-basis
       */
      basis: [{
        basis: [ze, "full", "auto", l, ...C()]
      }],
      /**
       * Flex Direction
       * @see https://tailwindcss.com/docs/flex-direction
       */
      "flex-direction": [{
        flex: ["row", "row-reverse", "col", "col-reverse"]
      }],
      /**
       * Flex Wrap
       * @see https://tailwindcss.com/docs/flex-wrap
       */
      "flex-wrap": [{
        flex: ["nowrap", "wrap", "wrap-reverse"]
      }],
      /**
       * Flex
       * @see https://tailwindcss.com/docs/flex
       */
      flex: [{
        flex: [$, ze, "auto", "initial", "none", _]
      }],
      /**
       * Flex Grow
       * @see https://tailwindcss.com/docs/flex-grow
       */
      grow: [{
        grow: ["", $, L, _]
      }],
      /**
       * Flex Shrink
       * @see https://tailwindcss.com/docs/flex-shrink
       */
      shrink: [{
        shrink: ["", $, L, _]
      }],
      /**
       * Order
       * @see https://tailwindcss.com/docs/order
       */
      order: [{
        order: [Ne, "first", "last", "none", L, _]
      }],
      /**
       * Grid Template Columns
       * @see https://tailwindcss.com/docs/grid-template-columns
       */
      "grid-cols": [{
        "grid-cols": M()
      }],
      /**
       * Grid Column Start / End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start-end": [{
        col: V()
      }],
      /**
       * Grid Column Start
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start": [{
        "col-start": R()
      }],
      /**
       * Grid Column End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-end": [{
        "col-end": R()
      }],
      /**
       * Grid Template Rows
       * @see https://tailwindcss.com/docs/grid-template-rows
       */
      "grid-rows": [{
        "grid-rows": M()
      }],
      /**
       * Grid Row Start / End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start-end": [{
        row: V()
      }],
      /**
       * Grid Row Start
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start": [{
        "row-start": R()
      }],
      /**
       * Grid Row End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-end": [{
        "row-end": R()
      }],
      /**
       * Grid Auto Flow
       * @see https://tailwindcss.com/docs/grid-auto-flow
       */
      "grid-flow": [{
        "grid-flow": ["row", "col", "dense", "row-dense", "col-dense"]
      }],
      /**
       * Grid Auto Columns
       * @see https://tailwindcss.com/docs/grid-auto-columns
       */
      "auto-cols": [{
        "auto-cols": O()
      }],
      /**
       * Grid Auto Rows
       * @see https://tailwindcss.com/docs/grid-auto-rows
       */
      "auto-rows": [{
        "auto-rows": O()
      }],
      /**
       * Gap
       * @see https://tailwindcss.com/docs/gap
       */
      gap: [{
        gap: C()
      }],
      /**
       * Gap X
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-x": [{
        "gap-x": C()
      }],
      /**
       * Gap Y
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-y": [{
        "gap-y": C()
      }],
      /**
       * Justify Content
       * @see https://tailwindcss.com/docs/justify-content
       */
      "justify-content": [{
        justify: [...H(), "normal"]
      }],
      /**
       * Justify Items
       * @see https://tailwindcss.com/docs/justify-items
       */
      "justify-items": [{
        "justify-items": [...D(), "normal"]
      }],
      /**
       * Justify Self
       * @see https://tailwindcss.com/docs/justify-self
       */
      "justify-self": [{
        "justify-self": ["auto", ...D()]
      }],
      /**
       * Align Content
       * @see https://tailwindcss.com/docs/align-content
       */
      "align-content": [{
        content: ["normal", ...H()]
      }],
      /**
       * Align Items
       * @see https://tailwindcss.com/docs/align-items
       */
      "align-items": [{
        items: [...D(), {
          baseline: ["", "last"]
        }]
      }],
      /**
       * Align Self
       * @see https://tailwindcss.com/docs/align-self
       */
      "align-self": [{
        self: ["auto", ...D(), {
          baseline: ["", "last"]
        }]
      }],
      /**
       * Place Content
       * @see https://tailwindcss.com/docs/place-content
       */
      "place-content": [{
        "place-content": H()
      }],
      /**
       * Place Items
       * @see https://tailwindcss.com/docs/place-items
       */
      "place-items": [{
        "place-items": [...D(), "baseline"]
      }],
      /**
       * Place Self
       * @see https://tailwindcss.com/docs/place-self
       */
      "place-self": [{
        "place-self": ["auto", ...D()]
      }],
      // Spacing
      /**
       * Padding
       * @see https://tailwindcss.com/docs/padding
       */
      p: [{
        p: C()
      }],
      /**
       * Padding X
       * @see https://tailwindcss.com/docs/padding
       */
      px: [{
        px: C()
      }],
      /**
       * Padding Y
       * @see https://tailwindcss.com/docs/padding
       */
      py: [{
        py: C()
      }],
      /**
       * Padding Start
       * @see https://tailwindcss.com/docs/padding
       */
      ps: [{
        ps: C()
      }],
      /**
       * Padding End
       * @see https://tailwindcss.com/docs/padding
       */
      pe: [{
        pe: C()
      }],
      /**
       * Padding Top
       * @see https://tailwindcss.com/docs/padding
       */
      pt: [{
        pt: C()
      }],
      /**
       * Padding Right
       * @see https://tailwindcss.com/docs/padding
       */
      pr: [{
        pr: C()
      }],
      /**
       * Padding Bottom
       * @see https://tailwindcss.com/docs/padding
       */
      pb: [{
        pb: C()
      }],
      /**
       * Padding Left
       * @see https://tailwindcss.com/docs/padding
       */
      pl: [{
        pl: C()
      }],
      /**
       * Margin
       * @see https://tailwindcss.com/docs/margin
       */
      m: [{
        m: P()
      }],
      /**
       * Margin X
       * @see https://tailwindcss.com/docs/margin
       */
      mx: [{
        mx: P()
      }],
      /**
       * Margin Y
       * @see https://tailwindcss.com/docs/margin
       */
      my: [{
        my: P()
      }],
      /**
       * Margin Start
       * @see https://tailwindcss.com/docs/margin
       */
      ms: [{
        ms: P()
      }],
      /**
       * Margin End
       * @see https://tailwindcss.com/docs/margin
       */
      me: [{
        me: P()
      }],
      /**
       * Margin Top
       * @see https://tailwindcss.com/docs/margin
       */
      mt: [{
        mt: P()
      }],
      /**
       * Margin Right
       * @see https://tailwindcss.com/docs/margin
       */
      mr: [{
        mr: P()
      }],
      /**
       * Margin Bottom
       * @see https://tailwindcss.com/docs/margin
       */
      mb: [{
        mb: P()
      }],
      /**
       * Margin Left
       * @see https://tailwindcss.com/docs/margin
       */
      ml: [{
        ml: P()
      }],
      /**
       * Space Between X
       * @see https://tailwindcss.com/docs/margin#adding-space-between-children
       */
      "space-x": [{
        "space-x": C()
      }],
      /**
       * Space Between X Reverse
       * @see https://tailwindcss.com/docs/margin#adding-space-between-children
       */
      "space-x-reverse": ["space-x-reverse"],
      /**
       * Space Between Y
       * @see https://tailwindcss.com/docs/margin#adding-space-between-children
       */
      "space-y": [{
        "space-y": C()
      }],
      /**
       * Space Between Y Reverse
       * @see https://tailwindcss.com/docs/margin#adding-space-between-children
       */
      "space-y-reverse": ["space-y-reverse"],
      // --------------
      // --- Sizing ---
      // --------------
      /**
       * Size
       * @see https://tailwindcss.com/docs/width#setting-both-width-and-height
       */
      size: [{
        size: W()
      }],
      /**
       * Width
       * @see https://tailwindcss.com/docs/width
       */
      w: [{
        w: [l, "screen", ...W()]
      }],
      /**
       * Min-Width
       * @see https://tailwindcss.com/docs/min-width
       */
      "min-w": [{
        "min-w": [
          l,
          "screen",
          /** Deprecated. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          "none",
          ...W()
        ]
      }],
      /**
       * Max-Width
       * @see https://tailwindcss.com/docs/max-width
       */
      "max-w": [{
        "max-w": [
          l,
          "screen",
          "none",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          "prose",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          {
            screen: [i]
          },
          ...W()
        ]
      }],
      /**
       * Height
       * @see https://tailwindcss.com/docs/height
       */
      h: [{
        h: ["screen", "lh", ...W()]
      }],
      /**
       * Min-Height
       * @see https://tailwindcss.com/docs/min-height
       */
      "min-h": [{
        "min-h": ["screen", "lh", "none", ...W()]
      }],
      /**
       * Max-Height
       * @see https://tailwindcss.com/docs/max-height
       */
      "max-h": [{
        "max-h": ["screen", "lh", ...W()]
      }],
      // ------------------
      // --- Typography ---
      // ------------------
      /**
       * Font Size
       * @see https://tailwindcss.com/docs/font-size
       */
      "font-size": [{
        text: ["base", n, rt, Oe]
      }],
      /**
       * Font Smoothing
       * @see https://tailwindcss.com/docs/font-smoothing
       */
      "font-smoothing": ["antialiased", "subpixel-antialiased"],
      /**
       * Font Style
       * @see https://tailwindcss.com/docs/font-style
       */
      "font-style": ["italic", "not-italic"],
      /**
       * Font Weight
       * @see https://tailwindcss.com/docs/font-weight
       */
      "font-weight": [{
        font: [o, L, Ut]
      }],
      /**
       * Font Stretch
       * @see https://tailwindcss.com/docs/font-stretch
       */
      "font-stretch": [{
        "font-stretch": ["ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded", Ft, _]
      }],
      /**
       * Font Family
       * @see https://tailwindcss.com/docs/font-family
       */
      "font-family": [{
        font: [qs, _, t]
      }],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-normal": ["normal-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-ordinal": ["ordinal"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-slashed-zero": ["slashed-zero"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-figure": ["lining-nums", "oldstyle-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-spacing": ["proportional-nums", "tabular-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-fraction": ["diagonal-fractions", "stacked-fractions"],
      /**
       * Letter Spacing
       * @see https://tailwindcss.com/docs/letter-spacing
       */
      tracking: [{
        tracking: [r, L, _]
      }],
      /**
       * Line Clamp
       * @see https://tailwindcss.com/docs/line-clamp
       */
      "line-clamp": [{
        "line-clamp": [$, "none", L, Ut]
      }],
      /**
       * Line Height
       * @see https://tailwindcss.com/docs/line-height
       */
      leading: [{
        leading: [
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          s,
          ...C()
        ]
      }],
      /**
       * List Style Image
       * @see https://tailwindcss.com/docs/list-style-image
       */
      "list-image": [{
        "list-image": ["none", L, _]
      }],
      /**
       * List Style Position
       * @see https://tailwindcss.com/docs/list-style-position
       */
      "list-style-position": [{
        list: ["inside", "outside"]
      }],
      /**
       * List Style Type
       * @see https://tailwindcss.com/docs/list-style-type
       */
      "list-style-type": [{
        list: ["disc", "decimal", "none", L, _]
      }],
      /**
       * Text Alignment
       * @see https://tailwindcss.com/docs/text-align
       */
      "text-alignment": [{
        text: ["left", "center", "right", "justify", "start", "end"]
      }],
      /**
       * Placeholder Color
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://v3.tailwindcss.com/docs/placeholder-color
       */
      "placeholder-color": [{
        placeholder: T()
      }],
      /**
       * Text Color
       * @see https://tailwindcss.com/docs/text-color
       */
      "text-color": [{
        text: T()
      }],
      /**
       * Text Decoration
       * @see https://tailwindcss.com/docs/text-decoration
       */
      "text-decoration": ["underline", "overline", "line-through", "no-underline"],
      /**
       * Text Decoration Style
       * @see https://tailwindcss.com/docs/text-decoration-style
       */
      "text-decoration-style": [{
        decoration: [...me(), "wavy"]
      }],
      /**
       * Text Decoration Thickness
       * @see https://tailwindcss.com/docs/text-decoration-thickness
       */
      "text-decoration-thickness": [{
        decoration: [$, "from-font", "auto", L, Oe]
      }],
      /**
       * Text Decoration Color
       * @see https://tailwindcss.com/docs/text-decoration-color
       */
      "text-decoration-color": [{
        decoration: T()
      }],
      /**
       * Text Underline Offset
       * @see https://tailwindcss.com/docs/text-underline-offset
       */
      "underline-offset": [{
        "underline-offset": [$, "auto", L, _]
      }],
      /**
       * Text Transform
       * @see https://tailwindcss.com/docs/text-transform
       */
      "text-transform": ["uppercase", "lowercase", "capitalize", "normal-case"],
      /**
       * Text Overflow
       * @see https://tailwindcss.com/docs/text-overflow
       */
      "text-overflow": ["truncate", "text-ellipsis", "text-clip"],
      /**
       * Text Wrap
       * @see https://tailwindcss.com/docs/text-wrap
       */
      "text-wrap": [{
        text: ["wrap", "nowrap", "balance", "pretty"]
      }],
      /**
       * Text Indent
       * @see https://tailwindcss.com/docs/text-indent
       */
      indent: [{
        indent: C()
      }],
      /**
       * Vertical Alignment
       * @see https://tailwindcss.com/docs/vertical-align
       */
      "vertical-align": [{
        align: ["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super", L, _]
      }],
      /**
       * Whitespace
       * @see https://tailwindcss.com/docs/whitespace
       */
      whitespace: [{
        whitespace: ["normal", "nowrap", "pre", "pre-line", "pre-wrap", "break-spaces"]
      }],
      /**
       * Word Break
       * @see https://tailwindcss.com/docs/word-break
       */
      break: [{
        break: ["normal", "words", "all", "keep"]
      }],
      /**
       * Overflow Wrap
       * @see https://tailwindcss.com/docs/overflow-wrap
       */
      wrap: [{
        wrap: ["break-word", "anywhere", "normal"]
      }],
      /**
       * Hyphens
       * @see https://tailwindcss.com/docs/hyphens
       */
      hyphens: [{
        hyphens: ["none", "manual", "auto"]
      }],
      /**
       * Content
       * @see https://tailwindcss.com/docs/content
       */
      content: [{
        content: ["none", L, _]
      }],
      // -------------------
      // --- Backgrounds ---
      // -------------------
      /**
       * Background Attachment
       * @see https://tailwindcss.com/docs/background-attachment
       */
      "bg-attachment": [{
        bg: ["fixed", "local", "scroll"]
      }],
      /**
       * Background Clip
       * @see https://tailwindcss.com/docs/background-clip
       */
      "bg-clip": [{
        "bg-clip": ["border", "padding", "content", "text"]
      }],
      /**
       * Background Origin
       * @see https://tailwindcss.com/docs/background-origin
       */
      "bg-origin": [{
        "bg-origin": ["border", "padding", "content"]
      }],
      /**
       * Background Position
       * @see https://tailwindcss.com/docs/background-position
       */
      "bg-position": [{
        bg: re()
      }],
      /**
       * Background Repeat
       * @see https://tailwindcss.com/docs/background-repeat
       */
      "bg-repeat": [{
        bg: ae()
      }],
      /**
       * Background Size
       * @see https://tailwindcss.com/docs/background-size
       */
      "bg-size": [{
        bg: de()
      }],
      /**
       * Background Image
       * @see https://tailwindcss.com/docs/background-image
       */
      "bg-image": [{
        bg: ["none", {
          linear: [{
            to: ["t", "tr", "r", "br", "b", "bl", "l", "tl"]
          }, Ne, L, _],
          radial: ["", L, _],
          conic: [Ne, L, _]
        }, Zs, Ks]
      }],
      /**
       * Background Color
       * @see https://tailwindcss.com/docs/background-color
       */
      "bg-color": [{
        bg: T()
      }],
      /**
       * Gradient Color Stops From Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from-pos": [{
        from: ie()
      }],
      /**
       * Gradient Color Stops Via Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via-pos": [{
        via: ie()
      }],
      /**
       * Gradient Color Stops To Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to-pos": [{
        to: ie()
      }],
      /**
       * Gradient Color Stops From
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from": [{
        from: T()
      }],
      /**
       * Gradient Color Stops Via
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via": [{
        via: T()
      }],
      /**
       * Gradient Color Stops To
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to": [{
        to: T()
      }],
      // ---------------
      // --- Borders ---
      // ---------------
      /**
       * Border Radius
       * @see https://tailwindcss.com/docs/border-radius
       */
      rounded: [{
        rounded: q()
      }],
      /**
       * Border Radius Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-s": [{
        "rounded-s": q()
      }],
      /**
       * Border Radius End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-e": [{
        "rounded-e": q()
      }],
      /**
       * Border Radius Top
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-t": [{
        "rounded-t": q()
      }],
      /**
       * Border Radius Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-r": [{
        "rounded-r": q()
      }],
      /**
       * Border Radius Bottom
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-b": [{
        "rounded-b": q()
      }],
      /**
       * Border Radius Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-l": [{
        "rounded-l": q()
      }],
      /**
       * Border Radius Start Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ss": [{
        "rounded-ss": q()
      }],
      /**
       * Border Radius Start End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-se": [{
        "rounded-se": q()
      }],
      /**
       * Border Radius End End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ee": [{
        "rounded-ee": q()
      }],
      /**
       * Border Radius End Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-es": [{
        "rounded-es": q()
      }],
      /**
       * Border Radius Top Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tl": [{
        "rounded-tl": q()
      }],
      /**
       * Border Radius Top Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tr": [{
        "rounded-tr": q()
      }],
      /**
       * Border Radius Bottom Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-br": [{
        "rounded-br": q()
      }],
      /**
       * Border Radius Bottom Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-bl": [{
        "rounded-bl": q()
      }],
      /**
       * Border Width
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w": [{
        border: Z()
      }],
      /**
       * Border Width X
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-x": [{
        "border-x": Z()
      }],
      /**
       * Border Width Y
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-y": [{
        "border-y": Z()
      }],
      /**
       * Border Width Start
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-s": [{
        "border-s": Z()
      }],
      /**
       * Border Width End
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-e": [{
        "border-e": Z()
      }],
      /**
       * Border Width Top
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-t": [{
        "border-t": Z()
      }],
      /**
       * Border Width Right
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-r": [{
        "border-r": Z()
      }],
      /**
       * Border Width Bottom
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-b": [{
        "border-b": Z()
      }],
      /**
       * Border Width Left
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-l": [{
        "border-l": Z()
      }],
      /**
       * Divide Width X
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-x": [{
        "divide-x": Z()
      }],
      /**
       * Divide Width X Reverse
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-x-reverse": ["divide-x-reverse"],
      /**
       * Divide Width Y
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-y": [{
        "divide-y": Z()
      }],
      /**
       * Divide Width Y Reverse
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-y-reverse": ["divide-y-reverse"],
      /**
       * Border Style
       * @see https://tailwindcss.com/docs/border-style
       */
      "border-style": [{
        border: [...me(), "hidden", "none"]
      }],
      /**
       * Divide Style
       * @see https://tailwindcss.com/docs/border-style#setting-the-divider-style
       */
      "divide-style": [{
        divide: [...me(), "hidden", "none"]
      }],
      /**
       * Border Color
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color": [{
        border: T()
      }],
      /**
       * Border Color X
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-x": [{
        "border-x": T()
      }],
      /**
       * Border Color Y
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-y": [{
        "border-y": T()
      }],
      /**
       * Border Color S
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-s": [{
        "border-s": T()
      }],
      /**
       * Border Color E
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-e": [{
        "border-e": T()
      }],
      /**
       * Border Color Top
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-t": [{
        "border-t": T()
      }],
      /**
       * Border Color Right
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-r": [{
        "border-r": T()
      }],
      /**
       * Border Color Bottom
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-b": [{
        "border-b": T()
      }],
      /**
       * Border Color Left
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-l": [{
        "border-l": T()
      }],
      /**
       * Divide Color
       * @see https://tailwindcss.com/docs/divide-color
       */
      "divide-color": [{
        divide: T()
      }],
      /**
       * Outline Style
       * @see https://tailwindcss.com/docs/outline-style
       */
      "outline-style": [{
        outline: [...me(), "none", "hidden"]
      }],
      /**
       * Outline Offset
       * @see https://tailwindcss.com/docs/outline-offset
       */
      "outline-offset": [{
        "outline-offset": [$, L, _]
      }],
      /**
       * Outline Width
       * @see https://tailwindcss.com/docs/outline-width
       */
      "outline-w": [{
        outline: ["", $, rt, Oe]
      }],
      /**
       * Outline Color
       * @see https://tailwindcss.com/docs/outline-color
       */
      "outline-color": [{
        outline: T()
      }],
      // ---------------
      // --- Effects ---
      // ---------------
      /**
       * Box Shadow
       * @see https://tailwindcss.com/docs/box-shadow
       */
      shadow: [{
        shadow: [
          // Deprecated since Tailwind CSS v4.0.0
          "",
          "none",
          d,
          ft,
          mt
        ]
      }],
      /**
       * Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-shadow-color
       */
      "shadow-color": [{
        shadow: T()
      }],
      /**
       * Inset Box Shadow
       * @see https://tailwindcss.com/docs/box-shadow#adding-an-inset-shadow
       */
      "inset-shadow": [{
        "inset-shadow": ["none", f, ft, mt]
      }],
      /**
       * Inset Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-inset-shadow-color
       */
      "inset-shadow-color": [{
        "inset-shadow": T()
      }],
      /**
       * Ring Width
       * @see https://tailwindcss.com/docs/box-shadow#adding-a-ring
       */
      "ring-w": [{
        ring: Z()
      }],
      /**
       * Ring Width Inset
       * @see https://v3.tailwindcss.com/docs/ring-width#inset-rings
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-w-inset": ["ring-inset"],
      /**
       * Ring Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-ring-color
       */
      "ring-color": [{
        ring: T()
      }],
      /**
       * Ring Offset Width
       * @see https://v3.tailwindcss.com/docs/ring-offset-width
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-offset-w": [{
        "ring-offset": [$, Oe]
      }],
      /**
       * Ring Offset Color
       * @see https://v3.tailwindcss.com/docs/ring-offset-color
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-offset-color": [{
        "ring-offset": T()
      }],
      /**
       * Inset Ring Width
       * @see https://tailwindcss.com/docs/box-shadow#adding-an-inset-ring
       */
      "inset-ring-w": [{
        "inset-ring": Z()
      }],
      /**
       * Inset Ring Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-inset-ring-color
       */
      "inset-ring-color": [{
        "inset-ring": T()
      }],
      /**
       * Text Shadow
       * @see https://tailwindcss.com/docs/text-shadow
       */
      "text-shadow": [{
        "text-shadow": ["none", m, ft, mt]
      }],
      /**
       * Text Shadow Color
       * @see https://tailwindcss.com/docs/text-shadow#setting-the-shadow-color
       */
      "text-shadow-color": [{
        "text-shadow": T()
      }],
      /**
       * Opacity
       * @see https://tailwindcss.com/docs/opacity
       */
      opacity: [{
        opacity: [$, L, _]
      }],
      /**
       * Mix Blend Mode
       * @see https://tailwindcss.com/docs/mix-blend-mode
       */
      "mix-blend": [{
        "mix-blend": [...ye(), "plus-darker", "plus-lighter"]
      }],
      /**
       * Background Blend Mode
       * @see https://tailwindcss.com/docs/background-blend-mode
       */
      "bg-blend": [{
        "bg-blend": ye()
      }],
      /**
       * Mask Clip
       * @see https://tailwindcss.com/docs/mask-clip
       */
      "mask-clip": [{
        "mask-clip": ["border", "padding", "content", "fill", "stroke", "view"]
      }, "mask-no-clip"],
      /**
       * Mask Composite
       * @see https://tailwindcss.com/docs/mask-composite
       */
      "mask-composite": [{
        mask: ["add", "subtract", "intersect", "exclude"]
      }],
      /**
       * Mask Image
       * @see https://tailwindcss.com/docs/mask-image
       */
      "mask-image-linear-pos": [{
        "mask-linear": [$]
      }],
      "mask-image-linear-from-pos": [{
        "mask-linear-from": J()
      }],
      "mask-image-linear-to-pos": [{
        "mask-linear-to": J()
      }],
      "mask-image-linear-from-color": [{
        "mask-linear-from": T()
      }],
      "mask-image-linear-to-color": [{
        "mask-linear-to": T()
      }],
      "mask-image-t-from-pos": [{
        "mask-t-from": J()
      }],
      "mask-image-t-to-pos": [{
        "mask-t-to": J()
      }],
      "mask-image-t-from-color": [{
        "mask-t-from": T()
      }],
      "mask-image-t-to-color": [{
        "mask-t-to": T()
      }],
      "mask-image-r-from-pos": [{
        "mask-r-from": J()
      }],
      "mask-image-r-to-pos": [{
        "mask-r-to": J()
      }],
      "mask-image-r-from-color": [{
        "mask-r-from": T()
      }],
      "mask-image-r-to-color": [{
        "mask-r-to": T()
      }],
      "mask-image-b-from-pos": [{
        "mask-b-from": J()
      }],
      "mask-image-b-to-pos": [{
        "mask-b-to": J()
      }],
      "mask-image-b-from-color": [{
        "mask-b-from": T()
      }],
      "mask-image-b-to-color": [{
        "mask-b-to": T()
      }],
      "mask-image-l-from-pos": [{
        "mask-l-from": J()
      }],
      "mask-image-l-to-pos": [{
        "mask-l-to": J()
      }],
      "mask-image-l-from-color": [{
        "mask-l-from": T()
      }],
      "mask-image-l-to-color": [{
        "mask-l-to": T()
      }],
      "mask-image-x-from-pos": [{
        "mask-x-from": J()
      }],
      "mask-image-x-to-pos": [{
        "mask-x-to": J()
      }],
      "mask-image-x-from-color": [{
        "mask-x-from": T()
      }],
      "mask-image-x-to-color": [{
        "mask-x-to": T()
      }],
      "mask-image-y-from-pos": [{
        "mask-y-from": J()
      }],
      "mask-image-y-to-pos": [{
        "mask-y-to": J()
      }],
      "mask-image-y-from-color": [{
        "mask-y-from": T()
      }],
      "mask-image-y-to-color": [{
        "mask-y-to": T()
      }],
      "mask-image-radial": [{
        "mask-radial": [L, _]
      }],
      "mask-image-radial-from-pos": [{
        "mask-radial-from": J()
      }],
      "mask-image-radial-to-pos": [{
        "mask-radial-to": J()
      }],
      "mask-image-radial-from-color": [{
        "mask-radial-from": T()
      }],
      "mask-image-radial-to-color": [{
        "mask-radial-to": T()
      }],
      "mask-image-radial-shape": [{
        "mask-radial": ["circle", "ellipse"]
      }],
      "mask-image-radial-size": [{
        "mask-radial": [{
          closest: ["side", "corner"],
          farthest: ["side", "corner"]
        }]
      }],
      "mask-image-radial-pos": [{
        "mask-radial-at": k()
      }],
      "mask-image-conic-pos": [{
        "mask-conic": [$]
      }],
      "mask-image-conic-from-pos": [{
        "mask-conic-from": J()
      }],
      "mask-image-conic-to-pos": [{
        "mask-conic-to": J()
      }],
      "mask-image-conic-from-color": [{
        "mask-conic-from": T()
      }],
      "mask-image-conic-to-color": [{
        "mask-conic-to": T()
      }],
      /**
       * Mask Mode
       * @see https://tailwindcss.com/docs/mask-mode
       */
      "mask-mode": [{
        mask: ["alpha", "luminance", "match"]
      }],
      /**
       * Mask Origin
       * @see https://tailwindcss.com/docs/mask-origin
       */
      "mask-origin": [{
        "mask-origin": ["border", "padding", "content", "fill", "stroke", "view"]
      }],
      /**
       * Mask Position
       * @see https://tailwindcss.com/docs/mask-position
       */
      "mask-position": [{
        mask: re()
      }],
      /**
       * Mask Repeat
       * @see https://tailwindcss.com/docs/mask-repeat
       */
      "mask-repeat": [{
        mask: ae()
      }],
      /**
       * Mask Size
       * @see https://tailwindcss.com/docs/mask-size
       */
      "mask-size": [{
        mask: de()
      }],
      /**
       * Mask Type
       * @see https://tailwindcss.com/docs/mask-type
       */
      "mask-type": [{
        "mask-type": ["alpha", "luminance"]
      }],
      /**
       * Mask Image
       * @see https://tailwindcss.com/docs/mask-image
       */
      "mask-image": [{
        mask: ["none", L, _]
      }],
      // ---------------
      // --- Filters ---
      // ---------------
      /**
       * Filter
       * @see https://tailwindcss.com/docs/filter
       */
      filter: [{
        filter: [
          // Deprecated since Tailwind CSS v3.0.0
          "",
          "none",
          L,
          _
        ]
      }],
      /**
       * Blur
       * @see https://tailwindcss.com/docs/blur
       */
      blur: [{
        blur: Fe()
      }],
      /**
       * Brightness
       * @see https://tailwindcss.com/docs/brightness
       */
      brightness: [{
        brightness: [$, L, _]
      }],
      /**
       * Contrast
       * @see https://tailwindcss.com/docs/contrast
       */
      contrast: [{
        contrast: [$, L, _]
      }],
      /**
       * Drop Shadow
       * @see https://tailwindcss.com/docs/drop-shadow
       */
      "drop-shadow": [{
        "drop-shadow": [
          // Deprecated since Tailwind CSS v4.0.0
          "",
          "none",
          w,
          ft,
          mt
        ]
      }],
      /**
       * Drop Shadow Color
       * @see https://tailwindcss.com/docs/filter-drop-shadow#setting-the-shadow-color
       */
      "drop-shadow-color": [{
        "drop-shadow": T()
      }],
      /**
       * Grayscale
       * @see https://tailwindcss.com/docs/grayscale
       */
      grayscale: [{
        grayscale: ["", $, L, _]
      }],
      /**
       * Hue Rotate
       * @see https://tailwindcss.com/docs/hue-rotate
       */
      "hue-rotate": [{
        "hue-rotate": [$, L, _]
      }],
      /**
       * Invert
       * @see https://tailwindcss.com/docs/invert
       */
      invert: [{
        invert: ["", $, L, _]
      }],
      /**
       * Saturate
       * @see https://tailwindcss.com/docs/saturate
       */
      saturate: [{
        saturate: [$, L, _]
      }],
      /**
       * Sepia
       * @see https://tailwindcss.com/docs/sepia
       */
      sepia: [{
        sepia: ["", $, L, _]
      }],
      /**
       * Backdrop Filter
       * @see https://tailwindcss.com/docs/backdrop-filter
       */
      "backdrop-filter": [{
        "backdrop-filter": [
          // Deprecated since Tailwind CSS v3.0.0
          "",
          "none",
          L,
          _
        ]
      }],
      /**
       * Backdrop Blur
       * @see https://tailwindcss.com/docs/backdrop-blur
       */
      "backdrop-blur": [{
        "backdrop-blur": Fe()
      }],
      /**
       * Backdrop Brightness
       * @see https://tailwindcss.com/docs/backdrop-brightness
       */
      "backdrop-brightness": [{
        "backdrop-brightness": [$, L, _]
      }],
      /**
       * Backdrop Contrast
       * @see https://tailwindcss.com/docs/backdrop-contrast
       */
      "backdrop-contrast": [{
        "backdrop-contrast": [$, L, _]
      }],
      /**
       * Backdrop Grayscale
       * @see https://tailwindcss.com/docs/backdrop-grayscale
       */
      "backdrop-grayscale": [{
        "backdrop-grayscale": ["", $, L, _]
      }],
      /**
       * Backdrop Hue Rotate
       * @see https://tailwindcss.com/docs/backdrop-hue-rotate
       */
      "backdrop-hue-rotate": [{
        "backdrop-hue-rotate": [$, L, _]
      }],
      /**
       * Backdrop Invert
       * @see https://tailwindcss.com/docs/backdrop-invert
       */
      "backdrop-invert": [{
        "backdrop-invert": ["", $, L, _]
      }],
      /**
       * Backdrop Opacity
       * @see https://tailwindcss.com/docs/backdrop-opacity
       */
      "backdrop-opacity": [{
        "backdrop-opacity": [$, L, _]
      }],
      /**
       * Backdrop Saturate
       * @see https://tailwindcss.com/docs/backdrop-saturate
       */
      "backdrop-saturate": [{
        "backdrop-saturate": [$, L, _]
      }],
      /**
       * Backdrop Sepia
       * @see https://tailwindcss.com/docs/backdrop-sepia
       */
      "backdrop-sepia": [{
        "backdrop-sepia": ["", $, L, _]
      }],
      // --------------
      // --- Tables ---
      // --------------
      /**
       * Border Collapse
       * @see https://tailwindcss.com/docs/border-collapse
       */
      "border-collapse": [{
        border: ["collapse", "separate"]
      }],
      /**
       * Border Spacing
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing": [{
        "border-spacing": C()
      }],
      /**
       * Border Spacing X
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-x": [{
        "border-spacing-x": C()
      }],
      /**
       * Border Spacing Y
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-y": [{
        "border-spacing-y": C()
      }],
      /**
       * Table Layout
       * @see https://tailwindcss.com/docs/table-layout
       */
      "table-layout": [{
        table: ["auto", "fixed"]
      }],
      /**
       * Caption Side
       * @see https://tailwindcss.com/docs/caption-side
       */
      caption: [{
        caption: ["top", "bottom"]
      }],
      // ---------------------------------
      // --- Transitions and Animation ---
      // ---------------------------------
      /**
       * Transition Property
       * @see https://tailwindcss.com/docs/transition-property
       */
      transition: [{
        transition: ["", "all", "colors", "opacity", "shadow", "transform", "none", L, _]
      }],
      /**
       * Transition Behavior
       * @see https://tailwindcss.com/docs/transition-behavior
       */
      "transition-behavior": [{
        transition: ["normal", "discrete"]
      }],
      /**
       * Transition Duration
       * @see https://tailwindcss.com/docs/transition-duration
       */
      duration: [{
        duration: [$, "initial", L, _]
      }],
      /**
       * Transition Timing Function
       * @see https://tailwindcss.com/docs/transition-timing-function
       */
      ease: [{
        ease: ["linear", "initial", h, L, _]
      }],
      /**
       * Transition Delay
       * @see https://tailwindcss.com/docs/transition-delay
       */
      delay: [{
        delay: [$, L, _]
      }],
      /**
       * Animation
       * @see https://tailwindcss.com/docs/animation
       */
      animate: [{
        animate: ["none", g, L, _]
      }],
      // ------------------
      // --- Transforms ---
      // ------------------
      /**
       * Backface Visibility
       * @see https://tailwindcss.com/docs/backface-visibility
       */
      backface: [{
        backface: ["hidden", "visible"]
      }],
      /**
       * Perspective
       * @see https://tailwindcss.com/docs/perspective
       */
      perspective: [{
        perspective: [b, L, _]
      }],
      /**
       * Perspective Origin
       * @see https://tailwindcss.com/docs/perspective-origin
       */
      "perspective-origin": [{
        "perspective-origin": E()
      }],
      /**
       * Rotate
       * @see https://tailwindcss.com/docs/rotate
       */
      rotate: [{
        rotate: xe()
      }],
      /**
       * Rotate X
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-x": [{
        "rotate-x": xe()
      }],
      /**
       * Rotate Y
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-y": [{
        "rotate-y": xe()
      }],
      /**
       * Rotate Z
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-z": [{
        "rotate-z": xe()
      }],
      /**
       * Scale
       * @see https://tailwindcss.com/docs/scale
       */
      scale: [{
        scale: Ce()
      }],
      /**
       * Scale X
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-x": [{
        "scale-x": Ce()
      }],
      /**
       * Scale Y
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-y": [{
        "scale-y": Ce()
      }],
      /**
       * Scale Z
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-z": [{
        "scale-z": Ce()
      }],
      /**
       * Scale 3D
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-3d": ["scale-3d"],
      /**
       * Skew
       * @see https://tailwindcss.com/docs/skew
       */
      skew: [{
        skew: Se()
      }],
      /**
       * Skew X
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-x": [{
        "skew-x": Se()
      }],
      /**
       * Skew Y
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-y": [{
        "skew-y": Se()
      }],
      /**
       * Transform
       * @see https://tailwindcss.com/docs/transform
       */
      transform: [{
        transform: [L, _, "", "none", "gpu", "cpu"]
      }],
      /**
       * Transform Origin
       * @see https://tailwindcss.com/docs/transform-origin
       */
      "transform-origin": [{
        origin: E()
      }],
      /**
       * Transform Style
       * @see https://tailwindcss.com/docs/transform-style
       */
      "transform-style": [{
        transform: ["3d", "flat"]
      }],
      /**
       * Translate
       * @see https://tailwindcss.com/docs/translate
       */
      translate: [{
        translate: Ve()
      }],
      /**
       * Translate X
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-x": [{
        "translate-x": Ve()
      }],
      /**
       * Translate Y
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-y": [{
        "translate-y": Ve()
      }],
      /**
       * Translate Z
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-z": [{
        "translate-z": Ve()
      }],
      /**
       * Translate None
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-none": ["translate-none"],
      // ---------------------
      // --- Interactivity ---
      // ---------------------
      /**
       * Accent Color
       * @see https://tailwindcss.com/docs/accent-color
       */
      accent: [{
        accent: T()
      }],
      /**
       * Appearance
       * @see https://tailwindcss.com/docs/appearance
       */
      appearance: [{
        appearance: ["none", "auto"]
      }],
      /**
       * Caret Color
       * @see https://tailwindcss.com/docs/just-in-time-mode#caret-color-utilities
       */
      "caret-color": [{
        caret: T()
      }],
      /**
       * Color Scheme
       * @see https://tailwindcss.com/docs/color-scheme
       */
      "color-scheme": [{
        scheme: ["normal", "dark", "light", "light-dark", "only-dark", "only-light"]
      }],
      /**
       * Cursor
       * @see https://tailwindcss.com/docs/cursor
       */
      cursor: [{
        cursor: ["auto", "default", "pointer", "wait", "text", "move", "help", "not-allowed", "none", "context-menu", "progress", "cell", "crosshair", "vertical-text", "alias", "copy", "no-drop", "grab", "grabbing", "all-scroll", "col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out", L, _]
      }],
      /**
       * Field Sizing
       * @see https://tailwindcss.com/docs/field-sizing
       */
      "field-sizing": [{
        "field-sizing": ["fixed", "content"]
      }],
      /**
       * Pointer Events
       * @see https://tailwindcss.com/docs/pointer-events
       */
      "pointer-events": [{
        "pointer-events": ["auto", "none"]
      }],
      /**
       * Resize
       * @see https://tailwindcss.com/docs/resize
       */
      resize: [{
        resize: ["none", "", "y", "x"]
      }],
      /**
       * Scroll Behavior
       * @see https://tailwindcss.com/docs/scroll-behavior
       */
      "scroll-behavior": [{
        scroll: ["auto", "smooth"]
      }],
      /**
       * Scroll Margin
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-m": [{
        "scroll-m": C()
      }],
      /**
       * Scroll Margin X
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mx": [{
        "scroll-mx": C()
      }],
      /**
       * Scroll Margin Y
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-my": [{
        "scroll-my": C()
      }],
      /**
       * Scroll Margin Start
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ms": [{
        "scroll-ms": C()
      }],
      /**
       * Scroll Margin End
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-me": [{
        "scroll-me": C()
      }],
      /**
       * Scroll Margin Top
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mt": [{
        "scroll-mt": C()
      }],
      /**
       * Scroll Margin Right
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mr": [{
        "scroll-mr": C()
      }],
      /**
       * Scroll Margin Bottom
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mb": [{
        "scroll-mb": C()
      }],
      /**
       * Scroll Margin Left
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ml": [{
        "scroll-ml": C()
      }],
      /**
       * Scroll Padding
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-p": [{
        "scroll-p": C()
      }],
      /**
       * Scroll Padding X
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-px": [{
        "scroll-px": C()
      }],
      /**
       * Scroll Padding Y
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-py": [{
        "scroll-py": C()
      }],
      /**
       * Scroll Padding Start
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-ps": [{
        "scroll-ps": C()
      }],
      /**
       * Scroll Padding End
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pe": [{
        "scroll-pe": C()
      }],
      /**
       * Scroll Padding Top
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pt": [{
        "scroll-pt": C()
      }],
      /**
       * Scroll Padding Right
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pr": [{
        "scroll-pr": C()
      }],
      /**
       * Scroll Padding Bottom
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pb": [{
        "scroll-pb": C()
      }],
      /**
       * Scroll Padding Left
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pl": [{
        "scroll-pl": C()
      }],
      /**
       * Scroll Snap Align
       * @see https://tailwindcss.com/docs/scroll-snap-align
       */
      "snap-align": [{
        snap: ["start", "end", "center", "align-none"]
      }],
      /**
       * Scroll Snap Stop
       * @see https://tailwindcss.com/docs/scroll-snap-stop
       */
      "snap-stop": [{
        snap: ["normal", "always"]
      }],
      /**
       * Scroll Snap Type
       * @see https://tailwindcss.com/docs/scroll-snap-type
       */
      "snap-type": [{
        snap: ["none", "x", "y", "both"]
      }],
      /**
       * Scroll Snap Type Strictness
       * @see https://tailwindcss.com/docs/scroll-snap-type
       */
      "snap-strictness": [{
        snap: ["mandatory", "proximity"]
      }],
      /**
       * Touch Action
       * @see https://tailwindcss.com/docs/touch-action
       */
      touch: [{
        touch: ["auto", "none", "manipulation"]
      }],
      /**
       * Touch Action X
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-x": [{
        "touch-pan": ["x", "left", "right"]
      }],
      /**
       * Touch Action Y
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-y": [{
        "touch-pan": ["y", "up", "down"]
      }],
      /**
       * Touch Action Pinch Zoom
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-pz": ["touch-pinch-zoom"],
      /**
       * User Select
       * @see https://tailwindcss.com/docs/user-select
       */
      select: [{
        select: ["none", "text", "all", "auto"]
      }],
      /**
       * Will Change
       * @see https://tailwindcss.com/docs/will-change
       */
      "will-change": [{
        "will-change": ["auto", "scroll", "contents", "transform", L, _]
      }],
      // -----------
      // --- SVG ---
      // -----------
      /**
       * Fill
       * @see https://tailwindcss.com/docs/fill
       */
      fill: [{
        fill: ["none", ...T()]
      }],
      /**
       * Stroke Width
       * @see https://tailwindcss.com/docs/stroke-width
       */
      "stroke-w": [{
        stroke: [$, rt, Oe, Ut]
      }],
      /**
       * Stroke
       * @see https://tailwindcss.com/docs/stroke
       */
      stroke: [{
        stroke: ["none", ...T()]
      }],
      // ---------------------
      // --- Accessibility ---
      // ---------------------
      /**
       * Forced Color Adjust
       * @see https://tailwindcss.com/docs/forced-color-adjust
       */
      "forced-color-adjust": [{
        "forced-color-adjust": ["auto", "none"]
      }]
    },
    conflictingClassGroups: {
      overflow: ["overflow-x", "overflow-y"],
      overscroll: ["overscroll-x", "overscroll-y"],
      inset: ["inset-x", "inset-y", "start", "end", "top", "right", "bottom", "left"],
      "inset-x": ["right", "left"],
      "inset-y": ["top", "bottom"],
      flex: ["basis", "grow", "shrink"],
      gap: ["gap-x", "gap-y"],
      p: ["px", "py", "ps", "pe", "pt", "pr", "pb", "pl"],
      px: ["pr", "pl"],
      py: ["pt", "pb"],
      m: ["mx", "my", "ms", "me", "mt", "mr", "mb", "ml"],
      mx: ["mr", "ml"],
      my: ["mt", "mb"],
      size: ["w", "h"],
      "font-size": ["leading"],
      "fvn-normal": ["fvn-ordinal", "fvn-slashed-zero", "fvn-figure", "fvn-spacing", "fvn-fraction"],
      "fvn-ordinal": ["fvn-normal"],
      "fvn-slashed-zero": ["fvn-normal"],
      "fvn-figure": ["fvn-normal"],
      "fvn-spacing": ["fvn-normal"],
      "fvn-fraction": ["fvn-normal"],
      "line-clamp": ["display", "overflow"],
      rounded: ["rounded-s", "rounded-e", "rounded-t", "rounded-r", "rounded-b", "rounded-l", "rounded-ss", "rounded-se", "rounded-ee", "rounded-es", "rounded-tl", "rounded-tr", "rounded-br", "rounded-bl"],
      "rounded-s": ["rounded-ss", "rounded-es"],
      "rounded-e": ["rounded-se", "rounded-ee"],
      "rounded-t": ["rounded-tl", "rounded-tr"],
      "rounded-r": ["rounded-tr", "rounded-br"],
      "rounded-b": ["rounded-br", "rounded-bl"],
      "rounded-l": ["rounded-tl", "rounded-bl"],
      "border-spacing": ["border-spacing-x", "border-spacing-y"],
      "border-w": ["border-w-x", "border-w-y", "border-w-s", "border-w-e", "border-w-t", "border-w-r", "border-w-b", "border-w-l"],
      "border-w-x": ["border-w-r", "border-w-l"],
      "border-w-y": ["border-w-t", "border-w-b"],
      "border-color": ["border-color-x", "border-color-y", "border-color-s", "border-color-e", "border-color-t", "border-color-r", "border-color-b", "border-color-l"],
      "border-color-x": ["border-color-r", "border-color-l"],
      "border-color-y": ["border-color-t", "border-color-b"],
      translate: ["translate-x", "translate-y", "translate-none"],
      "translate-none": ["translate", "translate-x", "translate-y", "translate-z"],
      "scroll-m": ["scroll-mx", "scroll-my", "scroll-ms", "scroll-me", "scroll-mt", "scroll-mr", "scroll-mb", "scroll-ml"],
      "scroll-mx": ["scroll-mr", "scroll-ml"],
      "scroll-my": ["scroll-mt", "scroll-mb"],
      "scroll-p": ["scroll-px", "scroll-py", "scroll-ps", "scroll-pe", "scroll-pt", "scroll-pr", "scroll-pb", "scroll-pl"],
      "scroll-px": ["scroll-pr", "scroll-pl"],
      "scroll-py": ["scroll-pt", "scroll-pb"],
      touch: ["touch-x", "touch-y", "touch-pz"],
      "touch-x": ["touch"],
      "touch-y": ["touch"],
      "touch-pz": ["touch"]
    },
    conflictingClassGroupModifiers: {
      "font-size": ["leading"]
    },
    orderSensitiveModifiers: ["*", "**", "after", "backdrop", "before", "details-content", "file", "first-letter", "first-line", "marker", "placeholder", "selection"]
  };
}, ni = /* @__PURE__ */ Os(ti);
function Y(...e) {
  return ni(oo(e));
}
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const oi = (e) => e.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), ri = (e) => e.replace(
  /^([A-Z])|[\s-_]+(\w)/g,
  (t, n, o) => o ? o.toUpperCase() : n.toLowerCase()
), Pn = (e) => {
  const t = ri(e);
  return t.charAt(0).toUpperCase() + t.slice(1);
}, vo = (...e) => e.filter((t, n, o) => !!t && t.trim() !== "" && o.indexOf(t) === n).join(" ").trim(), ai = (e) => {
  for (const t in e)
    if (t.startsWith("aria-") || t === "role" || t === "title")
      return !0;
};
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
var si = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const ii = jn(
  ({
    color: e = "currentColor",
    size: t = 24,
    strokeWidth: n = 2,
    absoluteStrokeWidth: o,
    className: r = "",
    children: s,
    iconNode: i,
    ...l
  }, c) => Wt(
    "svg",
    {
      ref: c,
      ...si,
      width: t,
      height: t,
      stroke: e,
      strokeWidth: o ? Number(n) * 24 / Number(t) : n,
      className: vo("lucide", r),
      ...!s && !ai(l) && { "aria-hidden": "true" },
      ...l
    },
    [
      ...i.map(([u, d]) => Wt(u, d)),
      ...Array.isArray(s) ? s : [s]
    ]
  )
);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const j = (e, t) => {
  const n = jn(
    ({ className: o, ...r }, s) => Wt(ii, {
      ref: s,
      iconNode: t,
      className: vo(
        `lucide-${oi(Pn(e))}`,
        `lucide-${e}`,
        o
      ),
      ...r
    })
  );
  return n.displayName = Pn(e), n;
};
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const li = [
  [
    "path",
    {
      d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
      key: "hh9hay"
    }
  ],
  ["path", { d: "m3.3 7 8.7 5 8.7-5", key: "g66t2b" }],
  ["path", { d: "M12 22V12", key: "d0xqtd" }]
], bo = j("box", li);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const ci = [
  [
    "path",
    {
      d: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z",
      key: "l5xja"
    }
  ],
  [
    "path",
    {
      d: "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z",
      key: "ep3f8r"
    }
  ],
  ["path", { d: "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4", key: "1p4c4q" }],
  ["path", { d: "M17.599 6.5a3 3 0 0 0 .399-1.375", key: "tmeiqw" }],
  ["path", { d: "M6.003 5.125A3 3 0 0 0 6.401 6.5", key: "105sqy" }],
  ["path", { d: "M3.477 10.896a4 4 0 0 1 .585-.396", key: "ql3yin" }],
  ["path", { d: "M19.938 10.5a4 4 0 0 1 .585.396", key: "1qfode" }],
  ["path", { d: "M6 18a4 4 0 0 1-1.967-.516", key: "2e4loj" }],
  ["path", { d: "M19.967 17.484A4 4 0 0 1 18 18", key: "159ez6" }]
], At = j("brain", ci);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const di = [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]], ui = j("check", di);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const mi = [["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]], fi = j("chevron-down", mi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const hi = [["path", { d: "m18 15-6-6-6 6", key: "153udz" }]], pi = j("chevron-up", hi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const gi = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["circle", { cx: "12", cy: "12", r: "1", key: "41hilf" }]
], vi = j("circle-dot", gi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const bi = [["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }]], wi = j("circle", bi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const yi = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M9 3v18", key: "fh3hqa" }],
  ["path", { d: "M15 3v18", key: "14nvp0" }]
], xi = j("columns-3", yi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Ci = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "M12 18a6 6 0 0 0 0-12v12z", key: "j4l70d" }]
], Tn = j("contrast", Ci);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Si = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["line", { x1: "22", x2: "18", y1: "12", y2: "12", key: "l9bcsi" }],
  ["line", { x1: "6", x2: "2", y1: "12", y2: "12", key: "13hhkx" }],
  ["line", { x1: "12", x2: "12", y1: "6", y2: "2", key: "10w3f3" }],
  ["line", { x1: "12", x2: "12", y1: "22", y2: "18", key: "15g9kq" }]
], Vn = j("crosshair", Si);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const ki = [
  ["ellipse", { cx: "12", cy: "5", rx: "9", ry: "3", key: "msslwz" }],
  ["path", { d: "M3 5V19A9 3 0 0 0 21 19V5", key: "1wlel7" }],
  ["path", { d: "M3 12A9 3 0 0 0 21 12", key: "mv7ke4" }]
], Ni = j("database", ki);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Ai = [
  ["path", { d: "M12 15V3", key: "m9g1x1" }],
  ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", key: "ih7n3h" }],
  ["path", { d: "m7 10 5 5 5-5", key: "brsn70" }]
], Mi = j("download", Ai);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Ei = [
  [
    "path",
    {
      d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
      key: "ct8e1f"
    }
  ],
  ["path", { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242", key: "151rxh" }],
  [
    "path",
    {
      d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
      key: "13bj9a"
    }
  ],
  ["path", { d: "m2 2 20 20", key: "1ooewy" }]
], qt = j("eye-off", Ei);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Di = [
  [
    "path",
    {
      d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
      key: "1nclc0"
    }
  ],
  ["circle", { cx: "12", cy: "12", r: "3", key: "1v7zrd" }]
], Jt = j("eye", Di);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Ii = [
  ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", key: "1rqfz7" }],
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }],
  ["path", { d: "M10 9H8", key: "b1mrlr" }],
  ["path", { d: "M16 13H8", key: "t4e002" }],
  ["path", { d: "M16 17H8", key: "z1uh3a" }]
], Ri = j("file-text", Ii);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Pi = [
  ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", key: "1rqfz7" }],
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }]
], Ti = j("file", Pi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Vi = [
  ["path", { d: "M12 3v18", key: "108xh3" }],
  ["path", { d: "M3 12h18", key: "1i2n21" }],
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2", key: "h1oib" }]
], Oi = j("grid-2x2", Vi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const _i = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2", key: "1m3agn" }],
  ["circle", { cx: "9", cy: "9", r: "2", key: "af1f0g" }],
  ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21", key: "1xmnt7" }]
], Li = j("image", _i);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Fi = [
  ["path", { d: "m16 17 5-5-5-5", key: "1bji2h" }],
  ["path", { d: "M21 12H9", key: "dn1m92" }],
  ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", key: "1uf3rs" }]
], Ui = j("log-out", Fi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const zi = [
  ["path", { d: "M15 3h6v6", key: "1q9fwt" }],
  ["path", { d: "m21 3-7 7", key: "1l2asr" }],
  ["path", { d: "m3 21 7-7", key: "tjx5ai" }],
  ["path", { d: "M9 21H3v-6", key: "wtvkvv" }]
], Wi = j("maximize-2", zi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Bi = [
  ["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z", key: "a7tn18" }]
], $i = j("moon", Bi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Gi = [
  ["path", { d: "M12.586 12.586 19 19", key: "ea5xo7" }],
  [
    "path",
    {
      d: "M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z",
      key: "277e5u"
    }
  ]
], ji = j("mouse-pointer", Gi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Hi = [
  ["path", { d: "M12 2v20", key: "t6zp3m" }],
  ["path", { d: "m15 19-3 3-3-3", key: "11eu04" }],
  ["path", { d: "m19 9 3 3-3 3", key: "1mg7y2" }],
  ["path", { d: "M2 12h20", key: "9i4pu4" }],
  ["path", { d: "m5 9-3 3 3 3", key: "j64kie" }],
  ["path", { d: "m9 5 3-3 3 3", key: "l8vdw6" }]
], On = j("move", Hi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Yi = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M3 15h18", key: "5xshup" }]
], Xi = j("panel-bottom", Yi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Ki = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M9 3v18", key: "fh3hqa" }]
], qi = j("panel-left", Ki);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Ji = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M15 3v18", key: "14nvp0" }]
], Zi = j("panel-right", Ji);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const Qi = [
  [
    "path",
    {
      d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      key: "1a8usu"
    }
  ],
  ["path", { d: "m15 5 4 4", key: "1mk7zo" }]
], Zt = j("pencil", Qi);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const el = [
  ["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "1357e3" }],
  ["path", { d: "M3 3v5h5", key: "1xhq8a" }]
], tl = j("rotate-ccw", el);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const nl = [
  [
    "path",
    {
      d: "M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z",
      key: "icamh8"
    }
  ],
  ["path", { d: "m14.5 12.5 2-2", key: "inckbg" }],
  ["path", { d: "m11.5 9.5 2-2", key: "fmmyf7" }],
  ["path", { d: "m8.5 6.5 2-2", key: "vc6u1g" }],
  ["path", { d: "m17.5 15.5 2-2", key: "wo5hmg" }]
], ol = j("ruler", nl);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const rl = [
  [
    "path",
    {
      d: "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
      key: "1c8476"
    }
  ],
  ["path", { d: "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7", key: "1ydtos" }],
  ["path", { d: "M7 3v4a1 1 0 0 0 1 1h7", key: "t51u73" }]
], wo = j("save", rl);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const al = [
  [
    "path",
    {
      d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      key: "1qme2f"
    }
  ],
  ["circle", { cx: "12", cy: "12", r: "3", key: "1v7zrd" }]
], sl = j("settings", al);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const il = [
  [
    "path",
    {
      d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
      key: "4pj2yx"
    }
  ],
  ["path", { d: "M20 3v4", key: "1olli1" }],
  ["path", { d: "M22 5h-4", key: "1gvqau" }],
  ["path", { d: "M4 17v2", key: "vumght" }],
  ["path", { d: "M5 18H3", key: "zchphs" }]
], ll = j("sparkles", il);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const cl = [
  ["path", { d: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", key: "1m0v6g" }],
  [
    "path",
    {
      d: "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
      key: "ohrbg2"
    }
  ]
], dl = j("square-pen", cl);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const ul = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }]
], ml = j("square", ul);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const fl = [
  ["circle", { cx: "12", cy: "12", r: "4", key: "4exip2" }],
  ["path", { d: "M12 2v2", key: "tus03m" }],
  ["path", { d: "M12 20v2", key: "1lh1kg" }],
  ["path", { d: "m4.93 4.93 1.41 1.41", key: "149t6j" }],
  ["path", { d: "m17.66 17.66 1.41 1.41", key: "ptbguv" }],
  ["path", { d: "M2 12h2", key: "1t8f8n" }],
  ["path", { d: "M20 12h2", key: "1q8mjw" }],
  ["path", { d: "m6.34 17.66-1.41 1.41", key: "1m8zz5" }],
  ["path", { d: "m19.07 4.93-1.41 1.41", key: "1shlcs" }]
], hl = j("sun", fl);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const pl = [
  ["path", { d: "M3 6h18", key: "d0wm0j" }],
  ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", key: "4alrt4" }],
  ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", key: "v07s0e" }],
  ["line", { x1: "10", x2: "10", y1: "11", y2: "17", key: "1uufr5" }],
  ["line", { x1: "14", x2: "14", y1: "11", y2: "17", key: "xtxkd" }]
], xt = j("trash-2", pl);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const gl = [
  ["path", { d: "M3 7v6h6", key: "1v2h90" }],
  ["path", { d: "M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13", key: "1r6uu6" }]
], yo = j("undo", gl);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const vl = [
  ["path", { d: "M12 3v12", key: "1x0j5s" }],
  ["path", { d: "m17 8-5-5-5 5", key: "7q97r8" }],
  ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", key: "ih7n3h" }]
], at = j("upload", vl);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const bl = [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
], wl = j("x", bl);
function _n(e, t) {
  if (typeof e == "function")
    return e(t);
  e != null && (e.current = t);
}
function Mt(...e) {
  return (t) => {
    let n = !1;
    const o = e.map((r) => {
      const s = _n(r, t);
      return !n && typeof s == "function" && (n = !0), s;
    });
    if (n)
      return () => {
        for (let r = 0; r < o.length; r++) {
          const s = o[r];
          typeof s == "function" ? s() : _n(e[r], null);
        }
      };
  };
}
function ee(...e) {
  return p.useCallback(Mt(...e), e);
}
var yl = Symbol.for("react.lazy"), Ct = p[" use ".trim().toString()];
function xl(e) {
  return typeof e == "object" && e !== null && "then" in e;
}
function xo(e) {
  return e != null && typeof e == "object" && "$$typeof" in e && e.$$typeof === yl && "_payload" in e && xl(e._payload);
}
// @__NO_SIDE_EFFECTS__
function Co(e) {
  const t = /* @__PURE__ */ Sl(e), n = p.forwardRef((o, r) => {
    let { children: s, ...i } = o;
    xo(s) && typeof Ct == "function" && (s = Ct(s._payload));
    const l = p.Children.toArray(s), c = l.find(Nl);
    if (c) {
      const u = c.props.children, d = l.map((f) => f === c ? p.Children.count(u) > 1 ? p.Children.only(null) : p.isValidElement(u) ? u.props.children : null : f);
      return /* @__PURE__ */ a(t, { ...i, ref: r, children: p.isValidElement(u) ? p.cloneElement(u, void 0, d) : null });
    }
    return /* @__PURE__ */ a(t, { ...i, ref: r, children: s });
  });
  return n.displayName = `${e}.Slot`, n;
}
var Cl = /* @__PURE__ */ Co("Slot");
// @__NO_SIDE_EFFECTS__
function Sl(e) {
  const t = p.forwardRef((n, o) => {
    let { children: r, ...s } = n;
    if (xo(r) && typeof Ct == "function" && (r = Ct(r._payload)), p.isValidElement(r)) {
      const i = Ml(r), l = Al(s, r.props);
      return r.type !== p.Fragment && (l.ref = o ? Mt(o, i) : i), p.cloneElement(r, l);
    }
    return p.Children.count(r) > 1 ? p.Children.only(null) : null;
  });
  return t.displayName = `${e}.SlotClone`, t;
}
var kl = Symbol("radix.slottable");
function Nl(e) {
  return p.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === kl;
}
function Al(e, t) {
  const n = { ...t };
  for (const o in t) {
    const r = e[o], s = t[o];
    /^on[A-Z]/.test(o) ? r && s ? n[o] = (...l) => {
      const c = s(...l);
      return r(...l), c;
    } : r && (n[o] = r) : o === "style" ? n[o] = { ...r, ...s } : o === "className" && (n[o] = [r, s].filter(Boolean).join(" "));
  }
  return { ...e, ...n };
}
function Ml(e) {
  var o, r;
  let t = (o = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : o.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (r = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : r.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
const Ln = (e) => typeof e == "boolean" ? `${e}` : e === 0 ? "0" : e, Fn = oo, So = (e, t) => (n) => {
  var o;
  if ((t == null ? void 0 : t.variants) == null) return Fn(e, n == null ? void 0 : n.class, n == null ? void 0 : n.className);
  const { variants: r, defaultVariants: s } = t, i = Object.keys(r).map((u) => {
    const d = n == null ? void 0 : n[u], f = s == null ? void 0 : s[u];
    if (d === null) return null;
    const m = Ln(d) || Ln(f);
    return r[u][m];
  }), l = n && Object.entries(n).reduce((u, d) => {
    let [f, m] = d;
    return m === void 0 || (u[f] = m), u;
  }, {}), c = t == null || (o = t.compoundVariants) === null || o === void 0 ? void 0 : o.reduce((u, d) => {
    let { class: f, className: m, ...w } = d;
    return Object.entries(w).every((S) => {
      let [b, v] = S;
      return Array.isArray(v) ? v.includes({
        ...s,
        ...l
      }[b]) : {
        ...s,
        ...l
      }[b] === v;
    }) ? [
      ...u,
      f,
      m
    ] : u;
  }, []);
  return Fn(e, i, c, n == null ? void 0 : n.class, n == null ? void 0 : n.className);
}, El = So(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive: "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline: "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);
function B({
  className: e,
  variant: t,
  size: n,
  asChild: o = !1,
  ...r
}) {
  return /* @__PURE__ */ a(
    o ? Cl : "button",
    {
      "data-slot": "button",
      className: Y(El({ variant: t, size: n, className: e })),
      ...r
    }
  );
}
function we(e, t = []) {
  let n = [];
  function o(s, i) {
    const l = p.createContext(i), c = n.length;
    n = [...n, i];
    const u = (f) => {
      var h;
      const { scope: m, children: w, ...S } = f, b = ((h = m == null ? void 0 : m[e]) == null ? void 0 : h[c]) || l, v = p.useMemo(() => S, Object.values(S));
      return /* @__PURE__ */ a(b.Provider, { value: v, children: w });
    };
    u.displayName = s + "Provider";
    function d(f, m) {
      var b;
      const w = ((b = m == null ? void 0 : m[e]) == null ? void 0 : b[c]) || l, S = p.useContext(w);
      if (S) return S;
      if (i !== void 0) return i;
      throw new Error(`\`${f}\` must be used within \`${s}\``);
    }
    return [u, d];
  }
  const r = () => {
    const s = n.map((i) => p.createContext(i));
    return function(l) {
      const c = (l == null ? void 0 : l[e]) || s;
      return p.useMemo(
        () => ({ [`__scope${e}`]: { ...l, [e]: c } }),
        [l, c]
      );
    };
  };
  return r.scopeName = e, [o, Dl(r, ...t)];
}
function Dl(...e) {
  const t = e[0];
  if (e.length === 1) return t;
  const n = () => {
    const o = e.map((r) => ({
      useScope: r(),
      scopeName: r.scopeName
    }));
    return function(s) {
      const i = o.reduce((l, { useScope: c, scopeName: u }) => {
        const f = c(s)[`__scope${u}`];
        return { ...l, ...f };
      }, {});
      return p.useMemo(() => ({ [`__scope${t.scopeName}`]: i }), [i]);
    };
  };
  return n.scopeName = t.scopeName, n;
}
// @__NO_SIDE_EFFECTS__
function Il(e) {
  const t = /* @__PURE__ */ Rl(e), n = p.forwardRef((o, r) => {
    const { children: s, ...i } = o, l = p.Children.toArray(s), c = l.find(Tl);
    if (c) {
      const u = c.props.children, d = l.map((f) => f === c ? p.Children.count(u) > 1 ? p.Children.only(null) : p.isValidElement(u) ? u.props.children : null : f);
      return /* @__PURE__ */ a(t, { ...i, ref: r, children: p.isValidElement(u) ? p.cloneElement(u, void 0, d) : null });
    }
    return /* @__PURE__ */ a(t, { ...i, ref: r, children: s });
  });
  return n.displayName = `${e}.Slot`, n;
}
// @__NO_SIDE_EFFECTS__
function Rl(e) {
  const t = p.forwardRef((n, o) => {
    const { children: r, ...s } = n;
    if (p.isValidElement(r)) {
      const i = Ol(r), l = Vl(s, r.props);
      return r.type !== p.Fragment && (l.ref = o ? Mt(o, i) : i), p.cloneElement(r, l);
    }
    return p.Children.count(r) > 1 ? p.Children.only(null) : null;
  });
  return t.displayName = `${e}.SlotClone`, t;
}
var Pl = Symbol("radix.slottable");
function Tl(e) {
  return p.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === Pl;
}
function Vl(e, t) {
  const n = { ...t };
  for (const o in t) {
    const r = e[o], s = t[o];
    /^on[A-Z]/.test(o) ? r && s ? n[o] = (...l) => {
      const c = s(...l);
      return r(...l), c;
    } : r && (n[o] = r) : o === "style" ? n[o] = { ...r, ...s } : o === "className" && (n[o] = [r, s].filter(Boolean).join(" "));
  }
  return { ...e, ...n };
}
function Ol(e) {
  var o, r;
  let t = (o = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : o.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (r = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : r.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
var _l = [
  "a",
  "button",
  "div",
  "form",
  "h2",
  "h3",
  "img",
  "input",
  "label",
  "li",
  "nav",
  "ol",
  "p",
  "select",
  "span",
  "svg",
  "ul"
], K = _l.reduce((e, t) => {
  const n = /* @__PURE__ */ Il(`Primitive.${t}`), o = p.forwardRef((r, s) => {
    const { asChild: i, ...l } = r, c = i ? n : t;
    return typeof window < "u" && (window[Symbol.for("radix-ui")] = !0), /* @__PURE__ */ a(c, { ...l, ref: s });
  });
  return o.displayName = `Primitive.${t}`, { ...e, [t]: o };
}, {});
function X(e, t, { checkForDefaultPrevented: n = !0 } = {}) {
  return function(r) {
    if (e == null || e(r), n === !1 || !r.defaultPrevented)
      return t == null ? void 0 : t(r);
  };
}
// @__NO_SIDE_EFFECTS__
function Un(e) {
  const t = /* @__PURE__ */ Ll(e), n = p.forwardRef((o, r) => {
    const { children: s, ...i } = o, l = p.Children.toArray(s), c = l.find(Ul);
    if (c) {
      const u = c.props.children, d = l.map((f) => f === c ? p.Children.count(u) > 1 ? p.Children.only(null) : p.isValidElement(u) ? u.props.children : null : f);
      return /* @__PURE__ */ a(t, { ...i, ref: r, children: p.isValidElement(u) ? p.cloneElement(u, void 0, d) : null });
    }
    return /* @__PURE__ */ a(t, { ...i, ref: r, children: s });
  });
  return n.displayName = `${e}.Slot`, n;
}
// @__NO_SIDE_EFFECTS__
function Ll(e) {
  const t = p.forwardRef((n, o) => {
    const { children: r, ...s } = n;
    if (p.isValidElement(r)) {
      const i = Wl(r), l = zl(s, r.props);
      return r.type !== p.Fragment && (l.ref = o ? Mt(o, i) : i), p.cloneElement(r, l);
    }
    return p.Children.count(r) > 1 ? p.Children.only(null) : null;
  });
  return t.displayName = `${e}.SlotClone`, t;
}
var Fl = Symbol("radix.slottable");
function Ul(e) {
  return p.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === Fl;
}
function zl(e, t) {
  const n = { ...t };
  for (const o in t) {
    const r = e[o], s = t[o];
    /^on[A-Z]/.test(o) ? r && s ? n[o] = (...l) => {
      const c = s(...l);
      return r(...l), c;
    } : r && (n[o] = r) : o === "style" ? n[o] = { ...r, ...s } : o === "className" && (n[o] = [r, s].filter(Boolean).join(" "));
  }
  return { ...e, ...n };
}
function Wl(e) {
  var o, r;
  let t = (o = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : o.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (r = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : r.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
function ko(e) {
  const t = e + "CollectionProvider", [n, o] = we(t), [r, s] = n(
    t,
    { collectionRef: { current: null }, itemMap: /* @__PURE__ */ new Map() }
  ), i = (b) => {
    const { scope: v, children: h } = b, g = Q.useRef(null), N = Q.useRef(/* @__PURE__ */ new Map()).current;
    return /* @__PURE__ */ a(r, { scope: v, itemMap: N, collectionRef: g, children: h });
  };
  i.displayName = t;
  const l = e + "CollectionSlot", c = /* @__PURE__ */ Un(l), u = Q.forwardRef(
    (b, v) => {
      const { scope: h, children: g } = b, N = s(l, h), k = ee(v, N.collectionRef);
      return /* @__PURE__ */ a(c, { ref: k, children: g });
    }
  );
  u.displayName = l;
  const d = e + "CollectionItemSlot", f = "data-radix-collection-item", m = /* @__PURE__ */ Un(d), w = Q.forwardRef(
    (b, v) => {
      const { scope: h, children: g, ...N } = b, k = Q.useRef(null), E = ee(v, k), U = s(d, h);
      return Q.useEffect(() => (U.itemMap.set(k, { ref: k, ...N }), () => void U.itemMap.delete(k))), /* @__PURE__ */ a(m, { [f]: "", ref: E, children: g });
    }
  );
  w.displayName = d;
  function S(b) {
    const v = s(e + "CollectionConsumer", b);
    return Q.useCallback(() => {
      const g = v.collectionRef.current;
      if (!g) return [];
      const N = Array.from(g.querySelectorAll(`[${f}]`));
      return Array.from(v.itemMap.values()).sort(
        (U, F) => N.indexOf(U.ref.current) - N.indexOf(F.ref.current)
      );
    }, [v.collectionRef, v.itemMap]);
  }
  return [
    { Provider: i, Slot: u, ItemSlot: w },
    S,
    o
  ];
}
var He = globalThis != null && globalThis.document ? p.useLayoutEffect : () => {
}, Bl = p[" useId ".trim().toString()] || (() => {
}), $l = 0;
function No(e) {
  const [t, n] = p.useState(Bl());
  return He(() => {
    n((o) => o ?? String($l++));
  }, [e]), e || (t ? `radix-${t}` : "");
}
function Ae(e) {
  const t = p.useRef(e);
  return p.useEffect(() => {
    t.current = e;
  }), p.useMemo(() => (...n) => {
    var o;
    return (o = t.current) == null ? void 0 : o.call(t, ...n);
  }, []);
}
var Gl = p[" useInsertionEffect ".trim().toString()] || He;
function Re({
  prop: e,
  defaultProp: t,
  onChange: n = () => {
  },
  caller: o
}) {
  const [r, s, i] = jl({
    defaultProp: t,
    onChange: n
  }), l = e !== void 0, c = l ? e : r;
  {
    const d = p.useRef(e !== void 0);
    p.useEffect(() => {
      const f = d.current;
      f !== l && console.warn(
        `${o} is changing from ${f ? "controlled" : "uncontrolled"} to ${l ? "controlled" : "uncontrolled"}. Components should not switch from controlled to uncontrolled (or vice versa). Decide between using a controlled or uncontrolled value for the lifetime of the component.`
      ), d.current = l;
    }, [l, o]);
  }
  const u = p.useCallback(
    (d) => {
      var f;
      if (l) {
        const m = Hl(d) ? d(e) : d;
        m !== e && ((f = i.current) == null || f.call(i, m));
      } else
        s(d);
    },
    [l, e, s, i]
  );
  return [c, u];
}
function jl({
  defaultProp: e,
  onChange: t
}) {
  const [n, o] = p.useState(e), r = p.useRef(n), s = p.useRef(t);
  return Gl(() => {
    s.current = t;
  }, [t]), p.useEffect(() => {
    var i;
    r.current !== n && ((i = s.current) == null || i.call(s, n), r.current = n);
  }, [n, r]), [n, o, s];
}
function Hl(e) {
  return typeof e == "function";
}
var Yl = p.createContext(void 0);
function qe(e) {
  const t = p.useContext(Yl);
  return e || t || "ltr";
}
var zt = "rovingFocusGroup.onEntryFocus", Xl = { bubbles: !1, cancelable: !0 }, st = "RovingFocusGroup", [Gt, Ao, Kl] = ko(st), [ql, Je] = we(
  st,
  [Kl]
), [Jl, Zl] = ql(st), Mo = p.forwardRef(
  (e, t) => /* @__PURE__ */ a(Gt.Provider, { scope: e.__scopeRovingFocusGroup, children: /* @__PURE__ */ a(Gt.Slot, { scope: e.__scopeRovingFocusGroup, children: /* @__PURE__ */ a(Ql, { ...e, ref: t }) }) })
);
Mo.displayName = st;
var Ql = p.forwardRef((e, t) => {
  const {
    __scopeRovingFocusGroup: n,
    orientation: o,
    loop: r = !1,
    dir: s,
    currentTabStopId: i,
    defaultCurrentTabStopId: l,
    onCurrentTabStopIdChange: c,
    onEntryFocus: u,
    preventScrollOnEntryFocus: d = !1,
    ...f
  } = e, m = p.useRef(null), w = ee(t, m), S = qe(s), [b, v] = Re({
    prop: i,
    defaultProp: l ?? null,
    onChange: c,
    caller: st
  }), [h, g] = p.useState(!1), N = Ae(u), k = Ao(n), E = p.useRef(!1), [U, F] = p.useState(0);
  return p.useEffect(() => {
    const C = m.current;
    if (C)
      return C.addEventListener(zt, N), () => C.removeEventListener(zt, N);
  }, [N]), /* @__PURE__ */ a(
    Jl,
    {
      scope: n,
      orientation: o,
      dir: S,
      loop: r,
      currentTabStopId: b,
      onItemFocus: p.useCallback(
        (C) => v(C),
        [v]
      ),
      onItemShiftTab: p.useCallback(() => g(!0), []),
      onFocusableItemAdd: p.useCallback(
        () => F((C) => C + 1),
        []
      ),
      onFocusableItemRemove: p.useCallback(
        () => F((C) => C - 1),
        []
      ),
      children: /* @__PURE__ */ a(
        K.div,
        {
          tabIndex: h || U === 0 ? -1 : 0,
          "data-orientation": o,
          ...f,
          ref: w,
          style: { outline: "none", ...e.style },
          onMouseDown: X(e.onMouseDown, () => {
            E.current = !0;
          }),
          onFocus: X(e.onFocus, (C) => {
            const x = !E.current;
            if (C.target === C.currentTarget && x && !h) {
              const M = new CustomEvent(zt, Xl);
              if (C.currentTarget.dispatchEvent(M), !M.defaultPrevented) {
                const V = k().filter((P) => P.focusable), R = V.find((P) => P.active), O = V.find((P) => P.id === b), D = [R, O, ...V].filter(
                  Boolean
                ).map((P) => P.ref.current);
                Io(D, d);
              }
            }
            E.current = !1;
          }),
          onBlur: X(e.onBlur, () => g(!1))
        }
      )
    }
  );
}), Eo = "RovingFocusGroupItem", Do = p.forwardRef(
  (e, t) => {
    const {
      __scopeRovingFocusGroup: n,
      focusable: o = !0,
      active: r = !1,
      tabStopId: s,
      children: i,
      ...l
    } = e, c = No(), u = s || c, d = Zl(Eo, n), f = d.currentTabStopId === u, m = Ao(n), { onFocusableItemAdd: w, onFocusableItemRemove: S, currentTabStopId: b } = d;
    return p.useEffect(() => {
      if (o)
        return w(), () => S();
    }, [o, w, S]), /* @__PURE__ */ a(
      Gt.ItemSlot,
      {
        scope: n,
        id: u,
        focusable: o,
        active: r,
        children: /* @__PURE__ */ a(
          K.span,
          {
            tabIndex: f ? 0 : -1,
            "data-orientation": d.orientation,
            ...l,
            ref: t,
            onMouseDown: X(e.onMouseDown, (v) => {
              o ? d.onItemFocus(u) : v.preventDefault();
            }),
            onFocus: X(e.onFocus, () => d.onItemFocus(u)),
            onKeyDown: X(e.onKeyDown, (v) => {
              if (v.key === "Tab" && v.shiftKey) {
                d.onItemShiftTab();
                return;
              }
              if (v.target !== v.currentTarget) return;
              const h = nc(v, d.orientation, d.dir);
              if (h !== void 0) {
                if (v.metaKey || v.ctrlKey || v.altKey || v.shiftKey) return;
                v.preventDefault();
                let N = m().filter((k) => k.focusable).map((k) => k.ref.current);
                if (h === "last") N.reverse();
                else if (h === "prev" || h === "next") {
                  h === "prev" && N.reverse();
                  const k = N.indexOf(v.currentTarget);
                  N = d.loop ? oc(N, k + 1) : N.slice(k + 1);
                }
                setTimeout(() => Io(N));
              }
            }),
            children: typeof i == "function" ? i({ isCurrentTabStop: f, hasTabStop: b != null }) : i
          }
        )
      }
    );
  }
);
Do.displayName = Eo;
var ec = {
  ArrowLeft: "prev",
  ArrowUp: "prev",
  ArrowRight: "next",
  ArrowDown: "next",
  PageUp: "first",
  Home: "first",
  PageDown: "last",
  End: "last"
};
function tc(e, t) {
  return t !== "rtl" ? e : e === "ArrowLeft" ? "ArrowRight" : e === "ArrowRight" ? "ArrowLeft" : e;
}
function nc(e, t, n) {
  const o = tc(e.key, n);
  if (!(t === "vertical" && ["ArrowLeft", "ArrowRight"].includes(o)) && !(t === "horizontal" && ["ArrowUp", "ArrowDown"].includes(o)))
    return ec[o];
}
function Io(e, t = !1) {
  const n = document.activeElement;
  for (const o of e)
    if (o === n || (o.focus({ preventScroll: t }), document.activeElement !== n)) return;
}
function oc(e, t) {
  return e.map((n, o) => e[(t + o) % e.length]);
}
var Qt = Mo, en = Do, Ro = "Toggle", Po = p.forwardRef((e, t) => {
  const { pressed: n, defaultPressed: o, onPressedChange: r, ...s } = e, [i, l] = Re({
    prop: n,
    onChange: r,
    defaultProp: o ?? !1,
    caller: Ro
  });
  return /* @__PURE__ */ a(
    K.button,
    {
      type: "button",
      "aria-pressed": i,
      "data-state": i ? "on" : "off",
      "data-disabled": e.disabled ? "" : void 0,
      ...s,
      ref: t,
      onClick: X(e.onClick, () => {
        e.disabled || l(!i);
      })
    }
  );
});
Po.displayName = Ro;
var Pe = "ToggleGroup", [To] = we(Pe, [
  Je
]), Vo = Je(), tn = Q.forwardRef((e, t) => {
  const { type: n, ...o } = e;
  if (n === "single")
    return /* @__PURE__ */ a(rc, { ...o, ref: t });
  if (n === "multiple")
    return /* @__PURE__ */ a(ac, { ...o, ref: t });
  throw new Error(`Missing prop \`type\` expected on \`${Pe}\``);
});
tn.displayName = Pe;
var [Oo, _o] = To(Pe), rc = Q.forwardRef((e, t) => {
  const {
    value: n,
    defaultValue: o,
    onValueChange: r = () => {
    },
    ...s
  } = e, [i, l] = Re({
    prop: n,
    defaultProp: o ?? "",
    onChange: r,
    caller: Pe
  });
  return /* @__PURE__ */ a(
    Oo,
    {
      scope: e.__scopeToggleGroup,
      type: "single",
      value: Q.useMemo(() => i ? [i] : [], [i]),
      onItemActivate: l,
      onItemDeactivate: Q.useCallback(() => l(""), [l]),
      children: /* @__PURE__ */ a(Lo, { ...s, ref: t })
    }
  );
}), ac = Q.forwardRef((e, t) => {
  const {
    value: n,
    defaultValue: o,
    onValueChange: r = () => {
    },
    ...s
  } = e, [i, l] = Re({
    prop: n,
    defaultProp: o ?? [],
    onChange: r,
    caller: Pe
  }), c = Q.useCallback(
    (d) => l((f = []) => [...f, d]),
    [l]
  ), u = Q.useCallback(
    (d) => l((f = []) => f.filter((m) => m !== d)),
    [l]
  );
  return /* @__PURE__ */ a(
    Oo,
    {
      scope: e.__scopeToggleGroup,
      type: "multiple",
      value: i,
      onItemActivate: c,
      onItemDeactivate: u,
      children: /* @__PURE__ */ a(Lo, { ...s, ref: t })
    }
  );
});
tn.displayName = Pe;
var [sc, ic] = To(Pe), Lo = Q.forwardRef(
  (e, t) => {
    const {
      __scopeToggleGroup: n,
      disabled: o = !1,
      rovingFocus: r = !0,
      orientation: s,
      dir: i,
      loop: l = !0,
      ...c
    } = e, u = Vo(n), d = qe(i), f = { role: "group", dir: d, ...c };
    return /* @__PURE__ */ a(sc, { scope: n, rovingFocus: r, disabled: o, children: r ? /* @__PURE__ */ a(
      Qt,
      {
        asChild: !0,
        ...u,
        orientation: s,
        dir: d,
        loop: l,
        children: /* @__PURE__ */ a(K.div, { ...f, ref: t })
      }
    ) : /* @__PURE__ */ a(K.div, { ...f, ref: t }) });
  }
), St = "ToggleGroupItem", Fo = Q.forwardRef(
  (e, t) => {
    const n = _o(St, e.__scopeToggleGroup), o = ic(St, e.__scopeToggleGroup), r = Vo(e.__scopeToggleGroup), s = n.value.includes(e.value), i = o.disabled || e.disabled, l = { ...e, pressed: s, disabled: i }, c = Q.useRef(null);
    return o.rovingFocus ? /* @__PURE__ */ a(
      en,
      {
        asChild: !0,
        ...r,
        focusable: !i,
        active: s,
        ref: c,
        children: /* @__PURE__ */ a(zn, { ...l, ref: t })
      }
    ) : /* @__PURE__ */ a(zn, { ...l, ref: t });
  }
);
Fo.displayName = St;
var zn = Q.forwardRef(
  (e, t) => {
    const { __scopeToggleGroup: n, value: o, ...r } = e, s = _o(St, n), i = { role: "radio", "aria-checked": e.pressed, "aria-pressed": void 0 }, l = s.type === "single" ? i : void 0;
    return /* @__PURE__ */ a(
      Po,
      {
        ...l,
        ...r,
        ref: t,
        onPressedChange: (c) => {
          c ? s.onItemActivate(o) : s.onItemDeactivate(o);
        }
      }
    );
  }
), lc = tn, cc = Fo;
const dc = So(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none transition-[color,box-shadow] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground"
      },
      size: {
        default: "h-9 px-2 min-w-9",
        sm: "h-8 px-1.5 min-w-8",
        lg: "h-10 px-2.5 min-w-10"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
), Uo = p.createContext({
  size: "default",
  variant: "default"
});
function zo({
  className: e,
  variant: t,
  size: n,
  children: o,
  ...r
}) {
  return /* @__PURE__ */ a(
    lc,
    {
      "data-slot": "toggle-group",
      "data-variant": t,
      "data-size": n,
      className: Y(
        "group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs",
        e
      ),
      ...r,
      children: /* @__PURE__ */ a(Uo.Provider, { value: { variant: t, size: n }, children: o })
    }
  );
}
function _e({
  className: e,
  children: t,
  variant: n,
  size: o,
  ...r
}) {
  const s = p.useContext(Uo);
  return /* @__PURE__ */ a(
    cc,
    {
      "data-slot": "toggle-group-item",
      "data-variant": s.variant || n,
      "data-size": s.size || o,
      className: Y(
        dc({
          variant: s.variant || n,
          size: s.size || o
        }),
        "min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus:z-10 focus-visible:z-10 data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l",
        e
      ),
      ...r,
      children: t
    }
  );
}
const uc = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABmJLR0QAMQBwAP8c8a2UAAAACXBIWXMAAA9hAAAPYQGoP6dpAAAAB3RJTUUH4AEUExQQFfKCQgAAACZpVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVAgb24gYSBNYWOV5F9bAAACcElEQVRIx5XWT4hXVRQH8M9vxmlKzE2CVqJiMgUzGUoLQQXN1iqI5EJQGUJIRURBDF20aSMRJFGgtGjhwkWUiEkKuhBSzDaJCFI0VCr4Lx3UmhF/br5P7jzm93N+Fx73vXPPPd97zv2ec163iY0GJmVuoEsHG1vJm3l/DWuxHI8xhJm4gB9wVYejAu3G+7gTsNu4i0eFrIldeKETgO7MG2JgFIewEIvwHt7FTvwRnc8maryK7QCuYxgftgnlW/g5IKs68eJgNm0uZC+iJx72YnLki3OQv/HKRGK/IsZP4+Vx9CYV71Xs92fPYBtvn41dUV5TyObiK/Tn+2NsLdb78RcuxtOWINPwYwCWFvIvw55/cTTrlzC/0Pk18uklQD1hXg3fv8tpKsWrATgQ6n6OKSFCNc5kXh6gxngAs3OBV/CwoOw/ife+nPoObuFmLh7OJRGXlHdaBxjI/EstJ/pxGa8nP07hDcxInnThBG5gdRmdOsDDFqHbiJ+wHutwLSdclvUe3I8HjfESqxovZR7J/D/2xMBxfBLqDuIbfBQbo0VY/msHUHH8cSHblqJ2JF58GoqOhDFL8aRFnoz9wO+Z5xWys4n7b/ggbOrDbpyvMalZXPq4WbwgSkcxNbJZAZhR6E8Jo8pkXIkH+L5GkDGjp6hDa1scpJ6lVbk4ln2LW/WaSrAE9+L6rMJIV/E0csKq4G2K8ZNF52tb8PYW5aCvIESjBihl+nr03+mkhX6dTcPYkTt4s0jGOTic3GkV0ud2tS0BaNaekVCziT9Tnzpq+tWFj6bBb8fb6cm94f4QvsC3RQifdPoD0D2BX5SedjpPAbRYi2qFhp13AAAAAElFTkSuQmCC", mc = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA9hAAAPYQGoP6dpAAAAB3RJTUUH4AEUEzUtwQXbsAAAACZpVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVAgb24gYSBNYWOV5F9bAAAB9klEQVRIx8WWP2gUQRTGf7u3yRGJKInkOAlXnNZaiE0Kg6nOQAohtWhrmjQemICCkM7SXkFBThBLlYCkC0JIUihnEbETD5EkFzn1ksvafAPPcY/duxQZWIaZeX++9733ZhaOeYRHPE8VGAauAh+B78BF4CHwFXgJjPWLPADuA3GG75PkM488sCPlA6AJzAMPjNELwKpZd4DxNEYcihj4o7niyUSebBFoGPnJNPQN4BD4oXUuAYSlY0DzsommbID8o3hOlMTACWCwh3wBrAP7wJtugksy/jhBmYyJdFEkjk2PxxAYAT4DH7yIHonOCS+xTdkYTUq4Oyyaw23gNbAB1LXnyncpAW1DeyWXP+vlpOa2Di8Dp4FrwFMjd0ZOF7WeMfT91FywlAZy5Pg7pSp4IsMVleE9yZcl9w54DryVfqCmi4HrpsIIhd45GBLfd83eTY+KEvDK5CwQqPdi4LYa9r8GcxG4+j+vko26NJwD6NB+kY3ZpDJfUZNtATeEYCCl/R24KaBqQOZ9vVDIDyXQMglLGzXR0pFuLU1hLq1hvPFNsi+A6aw36q4Q1RW+5T004V8yYK5kNZ4DFqT0W/Me8Eznt1SOv7ybl17fhbJKtWVQOodts1ft91WLDBUTHto7wNkuV3jfzgrAmu6gTA9+v38YUS9KfwHiN479kenpigAAAABJRU5ErkJggg==", fc = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA9hAAAPYQGoP6dpAAAAB3RJTUUH4AEUExsoumgmEwAAACZpVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVAgb24gYSBNYWOV5F9bAAACHUlEQVRIx+XVy4tOYRwH8M+M4R0iWcnrkgYxZTkimRIWppRSaLCxIAvFxj/AjFtsWFlQFBvCgrAQBuU2WbmMYWbIbWdqZsiMvDa/U09vx8zbTFaeenrOOb/v7/J8f5fDP15VFcpTXKnsHPUaV4Hz6tHeYAIGMQsbMAef8Ru9uIUvgS1gKGQVrdo49+NjUJHuAbzDc6xM9MZXYjwD3cavMHgVu3EXp/EtcfYdnVhWCa0ZXZdC+RNW5+AKaMCxoGso8DcwbSTjeyPyXiyIb5NGSOYRvAwnjzH9b8D56ApgU1k+YB1acAit2JbI6/A6dJ9hap6DAwE4VZaP+oisC5dxAReD+05sCdxC3AwbrZGPqjT6AfTHc7amRMLPYnZOUDtC72i8L43yLWFGSu3O+HiwzMBctKMRRVzH+8C+wSIsL+uBEyFvhprYDSG8X+agBw9wDRNxBifxFZvxNMr2YaLzNs7FmQNJBHnVsgfn8QF9OBy36cDa4Lotwc+Mszs1sj2udS+nlrPmKSblWEqacGOMk+Yo2e6Q1aVJnhw0lHA8blYdgEJg9oW8HSvwKGeMZLsl088o6o/SasSqABXwI+RLsCaa8EXkZRPWR7UUQ3YnHPfkDb8inoTxrUkDdcS3QfzEvGHyNeIc2hVRl8LwuXh+FQ1WX4avjhxle1inNUnztAVtpZz+qBrLX6wmGXBNMVmvRA7GbFwOt7Xxd/uP1x8qjZQl/fBreAAAAABJRU5ErkJggg==";
function hc({ currentView: e, onViewChange: t }) {
  return /* @__PURE__ */ a("div", { className: "flex items-center", children: /* @__PURE__ */ y(
    zo,
    {
      type: "single",
      value: e,
      onValueChange: (n) => n && t(n),
      children: [
        /* @__PURE__ */ y(_e, { value: "axial", "aria-label": "Axial view", title: "Axial view", children: [
          /* @__PURE__ */ a("img", { src: uc, alt: "axial", className: "dark:invert" }),
          /* @__PURE__ */ a("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "Axial" })
        ] }),
        /* @__PURE__ */ y(_e, { value: "coronal", "aria-label": "Coronal view", title: "Coronal view", children: [
          /* @__PURE__ */ a("img", { src: mc, alt: "coronal", className: "dark:invert" }),
          /* @__PURE__ */ a("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "Coronal" })
        ] }),
        /* @__PURE__ */ y(_e, { value: "sagittal", "aria-label": "Sagittal view", title: "Sagittal view", children: [
          /* @__PURE__ */ a("img", { src: fc, alt: "sagittal", className: "dark:invert" }),
          /* @__PURE__ */ a("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "Sagittal" })
        ] }),
        /* @__PURE__ */ y(_e, { value: "render", "aria-label": "Render view", title: "Render view", children: [
          /* @__PURE__ */ a(bo, { className: "h-4 w-4 mr-1" }),
          /* @__PURE__ */ a("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "Render" })
        ] }),
        /* @__PURE__ */ y(_e, { value: "ACS", "aria-label": "Multi view", title: "Multi view", children: [
          /* @__PURE__ */ a(xi, { className: "h-4 w-4 mr-1" }),
          /* @__PURE__ */ a("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "ACS" })
        ] }),
        /* @__PURE__ */ y(_e, { value: "ACSR", "aria-label": "Multi+Render", title: "Multi+Render", children: [
          /* @__PURE__ */ a(Oi, { className: "h-4 w-4 mr-1" }),
          /* @__PURE__ */ a("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "ACSR" })
        ] })
      ]
    }
  ) });
}
const pc = {
  none: { icon: ji, label: "None", displayName: "none" },
  contrast: { icon: Tn, label: "Contrast", displayName: "contrast" },
  measurement: { icon: ol, label: "Measurement", displayName: "measurement" },
  pan: { icon: On, label: "Pan/Zoom", displayName: "pan/zoom" },
  slicer3D: { icon: Wi, label: "Slicer 3D", displayName: "slicer3D" },
  callbackOnly: { icon: vi, label: "Callback Only", displayName: "callbackOnly" },
  roiSelection: { icon: ml, label: "ROI Selection", displayName: "roiSelection" },
  angle: { icon: Vn, label: "Angle", displayName: "angle" },
  crosshair: { icon: Vn, label: "Crosshair", displayName: "crosshair" },
  windowing: { icon: Tn, label: "Windowing", displayName: "windowing" },
  // rc.16: a click places the crosshair, a drag past a small threshold pans.
  crosshairPan: { icon: On, label: "Crosshair + Pan", displayName: "crosshair/pan" }
}, gc = Object.keys(pt).filter(
  (e) => isNaN(Number(e))
);
function vc({
  currentMode: e,
  onModeChange: t,
  availableModes: n = gc
}) {
  return /* @__PURE__ */ a("div", { className: "flex items-center", children: /* @__PURE__ */ a(
    zo,
    {
      type: "single",
      value: e,
      onValueChange: (o) => o && t(o),
      children: n.map((o) => {
        const r = pc[o], s = r.icon;
        return /* @__PURE__ */ y(
          _e,
          {
            value: o,
            "aria-label": r.label,
            title: r.label,
            children: [
              /* @__PURE__ */ a(s, { className: "h-4 w-4 mr-1" }),
              /* @__PURE__ */ a("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: r.displayName })
            ]
          },
          o
        );
      })
    }
  ) });
}
function bc({ nvRef: e }) {
  const t = A((m) => m.sidebarOpen), n = A((m) => m.setSidebarOpen), o = A((m) => m.footerOpen), r = A((m) => m.setFooterOpen), s = A((m) => m.darkMode), i = A((m) => m.setDarkMode), l = A(
    (m) => m.setSettingsDialogOpen
  ), {
    viewerOptions: c,
    handleViewMode: u,
    handleDragModeChange: d,
    resetViewAndContrast: f
  } = Xt(e);
  return /* @__PURE__ */ a("header", { className: "border-b bg-background px-6 py-3", children: /* @__PURE__ */ y("div", { className: "flex items-center justify-between", children: [
    /* @__PURE__ */ y("h1", { className: "text-xl font-semibold flex items-center", children: [
      /* @__PURE__ */ a(At, { className: "h-6 w-6 mr-2" }),
      /* @__PURE__ */ y(
        "a",
        {
          href: "https://github.com/freesurfer/freebrowse",
          target: "_blank",
          rel: "noopener noreferrer",
          children: [
            "FreeBrowse ",
            "2.5.0-next.1"
          ]
        }
      )
    ] }),
    /* @__PURE__ */ a("div", { className: "bg-background p-2", children: /* @__PURE__ */ y("div", { className: "flex items-center justify-between flex-wrap gap-4", children: [
      /* @__PURE__ */ y("div", { className: "flex items-center gap-2 border border-border rounded-md px-3 py-1", children: [
        /* @__PURE__ */ a("span", { className: "text-sm font-medium", children: "View:" }),
        /* @__PURE__ */ a(
          hc,
          {
            currentView: c.viewMode,
            onViewChange: u
          }
        )
      ] }),
      /* @__PURE__ */ y("div", { className: "flex items-center gap-2 border border-border rounded-md px-3 py-1", children: [
        /* @__PURE__ */ a("span", { className: "text-sm font-medium", children: "Right drag:" }),
        /* @__PURE__ */ a(
          vc,
          {
            currentMode: c.dragMode,
            onModeChange: d,
            availableModes: ["contrast", "pan"]
          }
        )
      ] })
    ] }) }),
    /* @__PURE__ */ y("div", { className: "flex items-center gap-2", children: [
      /* @__PURE__ */ a(
        B,
        {
          variant: "outline",
          size: "sm",
          onClick: f,
          className: "h-8 w-8 p-0",
          title: "Reset view+contrast of all volumes",
          children: /* @__PURE__ */ a(tl, { className: "h-4 w-4" })
        }
      ),
      /* @__PURE__ */ a(
        B,
        {
          variant: "outline",
          size: "sm",
          onClick: () => n(!t),
          className: "h-8 w-8 p-0",
          title: t ? "Hide sidebar" : "Show sidebar",
          children: t ? /* @__PURE__ */ a(Zi, { className: "h-4 w-4" }) : /* @__PURE__ */ a(qi, { className: "h-4 w-4" })
        }
      ),
      /* @__PURE__ */ a(
        B,
        {
          variant: "outline",
          size: "sm",
          onClick: () => r(!o),
          className: "h-8 w-8 p-0",
          title: o ? "Hide footer" : "Show footer",
          children: /* @__PURE__ */ a(
            Xi,
            {
              className: Y("h-4 w-4", !o && "rotate-180")
            }
          )
        }
      ),
      /* @__PURE__ */ a(
        B,
        {
          variant: "outline",
          size: "sm",
          onClick: () => i(!s),
          className: "h-8 w-8 p-0",
          title: s ? "Switch to light mode" : "Switch to dark mode",
          children: s ? /* @__PURE__ */ a(hl, { className: "h-4 w-4" }) : /* @__PURE__ */ a($i, { className: "h-4 w-4" })
        }
      ),
      /* @__PURE__ */ a(
        B,
        {
          variant: "outline",
          size: "sm",
          onClick: () => l(!0),
          className: "h-8 w-8 p-0",
          title: "Settings",
          children: /* @__PURE__ */ a(sl, { className: "h-4 w-4" })
        }
      )
    ] })
  ] }) });
}
function wc() {
  const e = A((t) => t.locationData);
  return /* @__PURE__ */ a("footer", { className: "border-t bg-background px-4 py-4 flex-shrink-0", children: e ? /* @__PURE__ */ y("div", { className: "space-y-2", children: [
    /* @__PURE__ */ y("div", { className: "grid grid-cols-[50%_auto_1fr] gap-4 items-center text-sm", children: [
      /* @__PURE__ */ a("div", {}),
      /* @__PURE__ */ y("div", { className: "text-muted-foreground font-mono whitespace-nowrap", children: [
        /* @__PURE__ */ a("span", { className: "inline-block w-16", children: "RAS" }),
        "[",
        e.mm[0].toFixed(1),
        ",",
        " ",
        e.mm[1].toFixed(1),
        ",",
        " ",
        e.mm[2].toFixed(1),
        "]"
      ] }),
      /* @__PURE__ */ a("div", {})
    ] }),
    e.voxels.map((t, n) => /* @__PURE__ */ y(
      "div",
      {
        className: Y(
          "grid grid-cols-[50%_auto_1fr] gap-4 items-center text-sm px-2 py-1 rounded-sm",
          n % 2 === 1 && "bg-accent"
        ),
        children: [
          /* @__PURE__ */ y("div", { className: "font-medium overflow-x-auto whitespace-nowrap", children: [
            t.name,
            ":"
          ] }),
          /* @__PURE__ */ y("div", { className: "text-muted-foreground font-mono whitespace-nowrap", children: [
            /* @__PURE__ */ a("span", { className: "inline-block w-16", children: "Voxel" }),
            "[",
            t.voxel[0],
            ", ",
            t.voxel[1],
            ", ",
            t.voxel[2],
            "]"
          ] }),
          /* @__PURE__ */ y("div", { className: "text-muted-foreground", children: [
            "Value: ",
            t.value.toFixed(2)
          ] })
        ]
      },
      n
    ))
  ] }) : /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground", children: "Load images to see coordinates" }) });
}
function yc({ onUpload: e, compact: t = !1 }) {
  const [n, o] = ce(!1), r = le(null), s = (d) => {
    d.preventDefault(), o(!0);
  }, i = () => {
    o(!1);
  }, l = (d) => {
    if (d.preventDefault(), o(!1), d.dataTransfer.files && d.dataTransfer.files.length > 0) {
      const f = Array.from(d.dataTransfer.files);
      e(f);
    }
  }, c = (d) => {
    if (d.target.files && d.target.files.length > 0) {
      console.log("Files selected:", d.target.files);
      const f = Array.from(d.target.files);
      e(f);
    }
  }, u = () => {
    var d;
    (d = r.current) == null || d.click();
  };
  return t ? /* @__PURE__ */ y("div", { className: "w-full", children: [
    /* @__PURE__ */ y(B, { variant: "outline", className: "w-full", onClick: u, children: [
      /* @__PURE__ */ a(at, { className: "mr-2 h-4 w-4" }),
      "Upload Images"
    ] }),
    /* @__PURE__ */ a(
      "input",
      {
        type: "file",
        ref: r,
        onChange: c,
        accept: "image/*",
        multiple: !0,
        className: "hidden"
      }
    )
  ] }) : /* @__PURE__ */ a(
    "div",
    {
      className: Y(
        "border-2 border-dashed rounded-lg p-12 text-center transition-colors",
        n ? "border-primary bg-primary/5" : "border-muted-foreground/25",
        "max-w-xl mx-auto w-full"
      ),
      onDragOver: s,
      onDragLeave: i,
      onDrop: l,
      children: /* @__PURE__ */ y("div", { className: "flex flex-col items-center justify-center gap-4", children: [
        /* @__PURE__ */ a("div", { className: "rounded-full bg-background p-3 shadow-sm", children: /* @__PURE__ */ a(Ti, { className: "h-10 w-10 text-muted-foreground" }) }),
        /* @__PURE__ */ y("div", { className: "grid gap-1 text-center", children: [
          /* @__PURE__ */ a("h3", { className: "text-lg font-semibold", children: "Load Medical Images" }),
          /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground", children: "Drag and drop your medical images here or click to browse" }),
          /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground", children: "No data will leave your device by loading data" })
        ] }),
        /* @__PURE__ */ y(B, { onClick: u, children: [
          /* @__PURE__ */ a(at, { className: "mr-2 h-4 w-4" }),
          "Select Files"
        ] }),
        /* @__PURE__ */ a(
          "input",
          {
            type: "file",
            ref: r,
            onChange: c,
            multiple: !0,
            className: "hidden"
          }
        )
      ] })
    }
  );
}
function xc({ viewMode: e, nvRef: t }) {
  const n = le(null), o = le(null), [r, s] = ce(!1);
  oe(() => {
    const c = n.current, u = t;
    console.log("NiiVue attached to canvas", u), c && u && (u.attachToCanvas(c), s(!0));
  }, []);
  const i = () => null;
  return /* @__PURE__ */ y(
    "div",
    {
      ref: o,
      className: "niivue-canvas w-full h-full relative bg-[#111]",
      children: [
        /* @__PURE__ */ a("canvas", { ref: n }),
        e === "ACSR" || e === "ACS" ? null : /* @__PURE__ */ y("div", { className: "absolute top-2 left-2 bg-black/50 text-white px-2 py-1 rounded text-xs font-medium", children: [
          e.charAt(0).toUpperCase() + e.slice(1),
          " View"
        ] }),
        i(),
        !r && /* @__PURE__ */ a("div", { className: "absolute inset-0 flex items-center justify-center text-white", children: "Loading image..." })
      ]
    }
  );
}
function Cc({
  nvInstance: e,
  viewMode: t,
  onFileUpload: n,
  nvCanvasEmptyState: o
}) {
  const r = A((s) => s.showUploader);
  return /* @__PURE__ */ a("main", { className: "flex-1 min-h-0 overflow-hidden flex flex-col", children: r ? /* @__PURE__ */ a("div", { className: "flex flex-1 items-center justify-center", children: o ?? /* @__PURE__ */ a(yc, { onUpload: n }) }) : /* @__PURE__ */ a("div", { className: "flex flex-1", children: /* @__PURE__ */ a(xc, { viewMode: t, nvRef: e }) }) });
}
function Sc({
  nvInstance: e,
  viewMode: t,
  onFileUpload: n,
  sidebar: o,
  dialogs: r,
  hiddenInputs: s,
  nvCanvasEmptyState: i
}) {
  const l = A((f) => f.sidebarOpen), c = A((f) => f.footerOpen), u = A((f) => f.darkMode), d = le(e);
  return d.current = e, /* @__PURE__ */ y(
    "div",
    {
      className: Y(
        "freebrowse-root relative flex h-full flex-col",
        u && "dark"
      ),
      children: [
        /* @__PURE__ */ a(bc, { nvRef: d }),
        /* @__PURE__ */ y("div", { className: "flex flex-1 overflow-hidden", children: [
          /* @__PURE__ */ y("div", { className: "flex flex-1 flex-col min-h-0", children: [
            /* @__PURE__ */ a(
              Cc,
              {
                nvInstance: e,
                viewMode: t,
                onFileUpload: n,
                nvCanvasEmptyState: i
              }
            ),
            c && /* @__PURE__ */ a(wc, {})
          ] }),
          l && o
        ] }),
        s,
        r
      ]
    }
  );
}
function kc(e, t) {
  return p.useReducer((n, o) => t[n][o] ?? n, e);
}
var Te = (e) => {
  const { present: t, children: n } = e, o = Nc(t), r = typeof n == "function" ? n({ present: o.isPresent }) : p.Children.only(n), s = ee(o.ref, Ac(r));
  return typeof n == "function" || o.isPresent ? p.cloneElement(r, { ref: s }) : null;
};
Te.displayName = "Presence";
function Nc(e) {
  const [t, n] = p.useState(), o = p.useRef(null), r = p.useRef(e), s = p.useRef("none"), i = e ? "mounted" : "unmounted", [l, c] = kc(i, {
    mounted: {
      UNMOUNT: "unmounted",
      ANIMATION_OUT: "unmountSuspended"
    },
    unmountSuspended: {
      MOUNT: "mounted",
      ANIMATION_END: "unmounted"
    },
    unmounted: {
      MOUNT: "mounted"
    }
  });
  return p.useEffect(() => {
    const u = ht(o.current);
    s.current = l === "mounted" ? u : "none";
  }, [l]), He(() => {
    const u = o.current, d = r.current;
    if (d !== e) {
      const m = s.current, w = ht(u);
      e ? c("MOUNT") : w === "none" || (u == null ? void 0 : u.display) === "none" ? c("UNMOUNT") : c(d && m !== w ? "ANIMATION_OUT" : "UNMOUNT"), r.current = e;
    }
  }, [e, c]), He(() => {
    if (t) {
      let u;
      const d = t.ownerDocument.defaultView ?? window, f = (w) => {
        const b = ht(o.current).includes(CSS.escape(w.animationName));
        if (w.target === t && b && (c("ANIMATION_END"), !r.current)) {
          const v = t.style.animationFillMode;
          t.style.animationFillMode = "forwards", u = d.setTimeout(() => {
            t.style.animationFillMode === "forwards" && (t.style.animationFillMode = v);
          });
        }
      }, m = (w) => {
        w.target === t && (s.current = ht(o.current));
      };
      return t.addEventListener("animationstart", m), t.addEventListener("animationcancel", f), t.addEventListener("animationend", f), () => {
        d.clearTimeout(u), t.removeEventListener("animationstart", m), t.removeEventListener("animationcancel", f), t.removeEventListener("animationend", f);
      };
    } else
      c("ANIMATION_END");
  }, [t, c]), {
    isPresent: ["mounted", "unmountSuspended"].includes(l),
    ref: p.useCallback((u) => {
      o.current = u ? getComputedStyle(u) : null, n(u);
    }, [])
  };
}
function ht(e) {
  return (e == null ? void 0 : e.animationName) || "none";
}
function Ac(e) {
  var o, r;
  let t = (o = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : o.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (r = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : r.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
var Et = "Tabs", [Mc] = we(Et, [
  Je
]), Wo = Je(), [Ec, nn] = Mc(Et), Bo = p.forwardRef(
  (e, t) => {
    const {
      __scopeTabs: n,
      value: o,
      onValueChange: r,
      defaultValue: s,
      orientation: i = "horizontal",
      dir: l,
      activationMode: c = "automatic",
      ...u
    } = e, d = qe(l), [f, m] = Re({
      prop: o,
      onChange: r,
      defaultProp: s ?? "",
      caller: Et
    });
    return /* @__PURE__ */ a(
      Ec,
      {
        scope: n,
        baseId: No(),
        value: f,
        onValueChange: m,
        orientation: i,
        dir: d,
        activationMode: c,
        children: /* @__PURE__ */ a(
          K.div,
          {
            dir: d,
            "data-orientation": i,
            ...u,
            ref: t
          }
        )
      }
    );
  }
);
Bo.displayName = Et;
var $o = "TabsList", Go = p.forwardRef(
  (e, t) => {
    const { __scopeTabs: n, loop: o = !0, ...r } = e, s = nn($o, n), i = Wo(n);
    return /* @__PURE__ */ a(
      Qt,
      {
        asChild: !0,
        ...i,
        orientation: s.orientation,
        dir: s.dir,
        loop: o,
        children: /* @__PURE__ */ a(
          K.div,
          {
            role: "tablist",
            "aria-orientation": s.orientation,
            ...r,
            ref: t
          }
        )
      }
    );
  }
);
Go.displayName = $o;
var jo = "TabsTrigger", Ho = p.forwardRef(
  (e, t) => {
    const { __scopeTabs: n, value: o, disabled: r = !1, ...s } = e, i = nn(jo, n), l = Wo(n), c = Ko(i.baseId, o), u = qo(i.baseId, o), d = o === i.value;
    return /* @__PURE__ */ a(
      en,
      {
        asChild: !0,
        ...l,
        focusable: !r,
        active: d,
        children: /* @__PURE__ */ a(
          K.button,
          {
            type: "button",
            role: "tab",
            "aria-selected": d,
            "aria-controls": u,
            "data-state": d ? "active" : "inactive",
            "data-disabled": r ? "" : void 0,
            disabled: r,
            id: c,
            ...s,
            ref: t,
            onMouseDown: X(e.onMouseDown, (f) => {
              !r && f.button === 0 && f.ctrlKey === !1 ? i.onValueChange(o) : f.preventDefault();
            }),
            onKeyDown: X(e.onKeyDown, (f) => {
              [" ", "Enter"].includes(f.key) && i.onValueChange(o);
            }),
            onFocus: X(e.onFocus, () => {
              const f = i.activationMode !== "manual";
              !d && !r && f && i.onValueChange(o);
            })
          }
        )
      }
    );
  }
);
Ho.displayName = jo;
var Yo = "TabsContent", Xo = p.forwardRef(
  (e, t) => {
    const { __scopeTabs: n, value: o, forceMount: r, children: s, ...i } = e, l = nn(Yo, n), c = Ko(l.baseId, o), u = qo(l.baseId, o), d = o === l.value, f = p.useRef(d);
    return p.useEffect(() => {
      const m = requestAnimationFrame(() => f.current = !1);
      return () => cancelAnimationFrame(m);
    }, []), /* @__PURE__ */ a(Te, { present: r || d, children: ({ present: m }) => /* @__PURE__ */ a(
      K.div,
      {
        "data-state": d ? "active" : "inactive",
        "data-orientation": l.orientation,
        role: "tabpanel",
        "aria-labelledby": c,
        hidden: !m,
        id: u,
        tabIndex: 0,
        ...i,
        ref: t,
        style: {
          ...e.style,
          animationDuration: f.current ? "0s" : void 0
        },
        children: m && s
      }
    ) });
  }
);
Xo.displayName = Yo;
function Ko(e, t) {
  return `${e}-trigger-${t}`;
}
function qo(e, t) {
  return `${e}-content-${t}`;
}
var Dc = Bo, Ic = Go, Rc = Ho, Pc = Xo;
function Tc({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ a(
    Dc,
    {
      "data-slot": "tabs",
      className: Y("flex flex-col gap-2", e),
      ...t
    }
  );
}
function Vc({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ a(
    Ic,
    {
      "data-slot": "tabs-list",
      className: Y(
        "bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]",
        e
      ),
      ...t
    }
  );
}
function We({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ a(
    Rc,
    {
      "data-slot": "tabs-trigger",
      className: Y(
        "data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        e
      ),
      ...t
    }
  );
}
function Be({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ a(
    Pc,
    {
      "data-slot": "tabs-content",
      className: Y("flex-1 outline-none", e),
      ...t
    }
  );
}
function on(e, [t, n]) {
  return Math.min(n, Math.max(t, e));
}
function Oc(e, t) {
  return p.useReducer((n, o) => t[n][o] ?? n, e);
}
var rn = "ScrollArea", [Jo] = we(rn), [_c, ue] = Jo(rn), Zo = p.forwardRef(
  (e, t) => {
    const {
      __scopeScrollArea: n,
      type: o = "hover",
      dir: r,
      scrollHideDelay: s = 600,
      ...i
    } = e, [l, c] = p.useState(null), [u, d] = p.useState(null), [f, m] = p.useState(null), [w, S] = p.useState(null), [b, v] = p.useState(null), [h, g] = p.useState(0), [N, k] = p.useState(0), [E, U] = p.useState(!1), [F, C] = p.useState(!1), x = ee(t, (V) => c(V)), M = qe(r);
    return /* @__PURE__ */ a(
      _c,
      {
        scope: n,
        type: o,
        dir: M,
        scrollHideDelay: s,
        scrollArea: l,
        viewport: u,
        onViewportChange: d,
        content: f,
        onContentChange: m,
        scrollbarX: w,
        onScrollbarXChange: S,
        scrollbarXEnabled: E,
        onScrollbarXEnabledChange: U,
        scrollbarY: b,
        onScrollbarYChange: v,
        scrollbarYEnabled: F,
        onScrollbarYEnabledChange: C,
        onCornerWidthChange: g,
        onCornerHeightChange: k,
        children: /* @__PURE__ */ a(
          K.div,
          {
            dir: M,
            ...i,
            ref: x,
            style: {
              position: "relative",
              // Pass corner sizes as CSS vars to reduce re-renders of context consumers
              "--radix-scroll-area-corner-width": h + "px",
              "--radix-scroll-area-corner-height": N + "px",
              ...e.style
            }
          }
        )
      }
    );
  }
);
Zo.displayName = rn;
var Qo = "ScrollAreaViewport", er = p.forwardRef(
  (e, t) => {
    const { __scopeScrollArea: n, children: o, nonce: r, ...s } = e, i = ue(Qo, n), l = p.useRef(null), c = ee(t, l, i.onViewportChange);
    return /* @__PURE__ */ y(De, { children: [
      /* @__PURE__ */ a(
        "style",
        {
          dangerouslySetInnerHTML: {
            __html: "[data-radix-scroll-area-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-scroll-area-viewport]::-webkit-scrollbar{display:none}"
          },
          nonce: r
        }
      ),
      /* @__PURE__ */ a(
        K.div,
        {
          "data-radix-scroll-area-viewport": "",
          ...s,
          ref: c,
          style: {
            /**
             * We don't support `visible` because the intention is to have at least one scrollbar
             * if this component is used and `visible` will behave like `auto` in that case
             * https://developer.mozilla.org/en-US/docs/Web/CSS/overflow#description
             *
             * We don't handle `auto` because the intention is for the native implementation
             * to be hidden if using this component. We just want to ensure the node is scrollable
             * so could have used either `scroll` or `auto` here. We picked `scroll` to prevent
             * the browser from having to work out whether to render native scrollbars or not,
             * we tell it to with the intention of hiding them in CSS.
             */
            overflowX: i.scrollbarXEnabled ? "scroll" : "hidden",
            overflowY: i.scrollbarYEnabled ? "scroll" : "hidden",
            ...e.style
          },
          children: /* @__PURE__ */ a("div", { ref: i.onContentChange, style: { minWidth: "100%", display: "table" }, children: o })
        }
      )
    ] });
  }
);
er.displayName = Qo;
var he = "ScrollAreaScrollbar", tr = p.forwardRef(
  (e, t) => {
    const { forceMount: n, ...o } = e, r = ue(he, e.__scopeScrollArea), { onScrollbarXEnabledChange: s, onScrollbarYEnabledChange: i } = r, l = e.orientation === "horizontal";
    return p.useEffect(() => (l ? s(!0) : i(!0), () => {
      l ? s(!1) : i(!1);
    }), [l, s, i]), r.type === "hover" ? /* @__PURE__ */ a(Lc, { ...o, ref: t, forceMount: n }) : r.type === "scroll" ? /* @__PURE__ */ a(Fc, { ...o, ref: t, forceMount: n }) : r.type === "auto" ? /* @__PURE__ */ a(nr, { ...o, ref: t, forceMount: n }) : r.type === "always" ? /* @__PURE__ */ a(an, { ...o, ref: t }) : null;
  }
);
tr.displayName = he;
var Lc = p.forwardRef((e, t) => {
  const { forceMount: n, ...o } = e, r = ue(he, e.__scopeScrollArea), [s, i] = p.useState(!1);
  return p.useEffect(() => {
    const l = r.scrollArea;
    let c = 0;
    if (l) {
      const u = () => {
        window.clearTimeout(c), i(!0);
      }, d = () => {
        c = window.setTimeout(() => i(!1), r.scrollHideDelay);
      };
      return l.addEventListener("pointerenter", u), l.addEventListener("pointerleave", d), () => {
        window.clearTimeout(c), l.removeEventListener("pointerenter", u), l.removeEventListener("pointerleave", d);
      };
    }
  }, [r.scrollArea, r.scrollHideDelay]), /* @__PURE__ */ a(Te, { present: n || s, children: /* @__PURE__ */ a(
    nr,
    {
      "data-state": s ? "visible" : "hidden",
      ...o,
      ref: t
    }
  ) });
}), Fc = p.forwardRef((e, t) => {
  const { forceMount: n, ...o } = e, r = ue(he, e.__scopeScrollArea), s = e.orientation === "horizontal", i = It(() => c("SCROLL_END"), 100), [l, c] = Oc("hidden", {
    hidden: {
      SCROLL: "scrolling"
    },
    scrolling: {
      SCROLL_END: "idle",
      POINTER_ENTER: "interacting"
    },
    interacting: {
      SCROLL: "interacting",
      POINTER_LEAVE: "idle"
    },
    idle: {
      HIDE: "hidden",
      SCROLL: "scrolling",
      POINTER_ENTER: "interacting"
    }
  });
  return p.useEffect(() => {
    if (l === "idle") {
      const u = window.setTimeout(() => c("HIDE"), r.scrollHideDelay);
      return () => window.clearTimeout(u);
    }
  }, [l, r.scrollHideDelay, c]), p.useEffect(() => {
    const u = r.viewport, d = s ? "scrollLeft" : "scrollTop";
    if (u) {
      let f = u[d];
      const m = () => {
        const w = u[d];
        f !== w && (c("SCROLL"), i()), f = w;
      };
      return u.addEventListener("scroll", m), () => u.removeEventListener("scroll", m);
    }
  }, [r.viewport, s, c, i]), /* @__PURE__ */ a(Te, { present: n || l !== "hidden", children: /* @__PURE__ */ a(
    an,
    {
      "data-state": l === "hidden" ? "hidden" : "visible",
      ...o,
      ref: t,
      onPointerEnter: X(e.onPointerEnter, () => c("POINTER_ENTER")),
      onPointerLeave: X(e.onPointerLeave, () => c("POINTER_LEAVE"))
    }
  ) });
}), nr = p.forwardRef((e, t) => {
  const n = ue(he, e.__scopeScrollArea), { forceMount: o, ...r } = e, [s, i] = p.useState(!1), l = e.orientation === "horizontal", c = It(() => {
    if (n.viewport) {
      const u = n.viewport.offsetWidth < n.viewport.scrollWidth, d = n.viewport.offsetHeight < n.viewport.scrollHeight;
      i(l ? u : d);
    }
  }, 10);
  return Ye(n.viewport, c), Ye(n.content, c), /* @__PURE__ */ a(Te, { present: o || s, children: /* @__PURE__ */ a(
    an,
    {
      "data-state": s ? "visible" : "hidden",
      ...r,
      ref: t
    }
  ) });
}), an = p.forwardRef((e, t) => {
  const { orientation: n = "vertical", ...o } = e, r = ue(he, e.__scopeScrollArea), s = p.useRef(null), i = p.useRef(0), [l, c] = p.useState({
    content: 0,
    viewport: 0,
    scrollbar: { size: 0, paddingStart: 0, paddingEnd: 0 }
  }), u = ir(l.viewport, l.content), d = {
    ...o,
    sizes: l,
    onSizesChange: c,
    hasThumb: u > 0 && u < 1,
    onThumbChange: (m) => s.current = m,
    onThumbPointerUp: () => i.current = 0,
    onThumbPointerDown: (m) => i.current = m
  };
  function f(m, w) {
    return Gc(m, i.current, l, w);
  }
  return n === "horizontal" ? /* @__PURE__ */ a(
    Uc,
    {
      ...d,
      ref: t,
      onThumbPositionChange: () => {
        if (r.viewport && s.current) {
          const m = r.viewport.scrollLeft, w = Wn(m, l, r.dir);
          s.current.style.transform = `translate3d(${w}px, 0, 0)`;
        }
      },
      onWheelScroll: (m) => {
        r.viewport && (r.viewport.scrollLeft = m);
      },
      onDragScroll: (m) => {
        r.viewport && (r.viewport.scrollLeft = f(m, r.dir));
      }
    }
  ) : n === "vertical" ? /* @__PURE__ */ a(
    zc,
    {
      ...d,
      ref: t,
      onThumbPositionChange: () => {
        if (r.viewport && s.current) {
          const m = r.viewport.scrollTop, w = Wn(m, l);
          s.current.style.transform = `translate3d(0, ${w}px, 0)`;
        }
      },
      onWheelScroll: (m) => {
        r.viewport && (r.viewport.scrollTop = m);
      },
      onDragScroll: (m) => {
        r.viewport && (r.viewport.scrollTop = f(m));
      }
    }
  ) : null;
}), Uc = p.forwardRef((e, t) => {
  const { sizes: n, onSizesChange: o, ...r } = e, s = ue(he, e.__scopeScrollArea), [i, l] = p.useState(), c = p.useRef(null), u = ee(t, c, s.onScrollbarXChange);
  return p.useEffect(() => {
    c.current && l(getComputedStyle(c.current));
  }, [c]), /* @__PURE__ */ a(
    rr,
    {
      "data-orientation": "horizontal",
      ...r,
      ref: u,
      sizes: n,
      style: {
        bottom: 0,
        left: s.dir === "rtl" ? "var(--radix-scroll-area-corner-width)" : 0,
        right: s.dir === "ltr" ? "var(--radix-scroll-area-corner-width)" : 0,
        "--radix-scroll-area-thumb-width": Dt(n) + "px",
        ...e.style
      },
      onThumbPointerDown: (d) => e.onThumbPointerDown(d.x),
      onDragScroll: (d) => e.onDragScroll(d.x),
      onWheelScroll: (d, f) => {
        if (s.viewport) {
          const m = s.viewport.scrollLeft + d.deltaX;
          e.onWheelScroll(m), cr(m, f) && d.preventDefault();
        }
      },
      onResize: () => {
        c.current && s.viewport && i && o({
          content: s.viewport.scrollWidth,
          viewport: s.viewport.offsetWidth,
          scrollbar: {
            size: c.current.clientWidth,
            paddingStart: Nt(i.paddingLeft),
            paddingEnd: Nt(i.paddingRight)
          }
        });
      }
    }
  );
}), zc = p.forwardRef((e, t) => {
  const { sizes: n, onSizesChange: o, ...r } = e, s = ue(he, e.__scopeScrollArea), [i, l] = p.useState(), c = p.useRef(null), u = ee(t, c, s.onScrollbarYChange);
  return p.useEffect(() => {
    c.current && l(getComputedStyle(c.current));
  }, [c]), /* @__PURE__ */ a(
    rr,
    {
      "data-orientation": "vertical",
      ...r,
      ref: u,
      sizes: n,
      style: {
        top: 0,
        right: s.dir === "ltr" ? 0 : void 0,
        left: s.dir === "rtl" ? 0 : void 0,
        bottom: "var(--radix-scroll-area-corner-height)",
        "--radix-scroll-area-thumb-height": Dt(n) + "px",
        ...e.style
      },
      onThumbPointerDown: (d) => e.onThumbPointerDown(d.y),
      onDragScroll: (d) => e.onDragScroll(d.y),
      onWheelScroll: (d, f) => {
        if (s.viewport) {
          const m = s.viewport.scrollTop + d.deltaY;
          e.onWheelScroll(m), cr(m, f) && d.preventDefault();
        }
      },
      onResize: () => {
        c.current && s.viewport && i && o({
          content: s.viewport.scrollHeight,
          viewport: s.viewport.offsetHeight,
          scrollbar: {
            size: c.current.clientHeight,
            paddingStart: Nt(i.paddingTop),
            paddingEnd: Nt(i.paddingBottom)
          }
        });
      }
    }
  );
}), [Wc, or] = Jo(he), rr = p.forwardRef((e, t) => {
  const {
    __scopeScrollArea: n,
    sizes: o,
    hasThumb: r,
    onThumbChange: s,
    onThumbPointerUp: i,
    onThumbPointerDown: l,
    onThumbPositionChange: c,
    onDragScroll: u,
    onWheelScroll: d,
    onResize: f,
    ...m
  } = e, w = ue(he, n), [S, b] = p.useState(null), v = ee(t, (x) => b(x)), h = p.useRef(null), g = p.useRef(""), N = w.viewport, k = o.content - o.viewport, E = Ae(d), U = Ae(c), F = It(f, 10);
  function C(x) {
    if (h.current) {
      const M = x.clientX - h.current.left, V = x.clientY - h.current.top;
      u({ x: M, y: V });
    }
  }
  return p.useEffect(() => {
    const x = (M) => {
      const V = M.target;
      (S == null ? void 0 : S.contains(V)) && E(M, k);
    };
    return document.addEventListener("wheel", x, { passive: !1 }), () => document.removeEventListener("wheel", x, { passive: !1 });
  }, [N, S, k, E]), p.useEffect(U, [o, U]), Ye(S, F), Ye(w.content, F), /* @__PURE__ */ a(
    Wc,
    {
      scope: n,
      scrollbar: S,
      hasThumb: r,
      onThumbChange: Ae(s),
      onThumbPointerUp: Ae(i),
      onThumbPositionChange: U,
      onThumbPointerDown: Ae(l),
      children: /* @__PURE__ */ a(
        K.div,
        {
          ...m,
          ref: v,
          style: { position: "absolute", ...m.style },
          onPointerDown: X(e.onPointerDown, (x) => {
            x.button === 0 && (x.target.setPointerCapture(x.pointerId), h.current = S.getBoundingClientRect(), g.current = document.body.style.webkitUserSelect, document.body.style.webkitUserSelect = "none", w.viewport && (w.viewport.style.scrollBehavior = "auto"), C(x));
          }),
          onPointerMove: X(e.onPointerMove, C),
          onPointerUp: X(e.onPointerUp, (x) => {
            const M = x.target;
            M.hasPointerCapture(x.pointerId) && M.releasePointerCapture(x.pointerId), document.body.style.webkitUserSelect = g.current, w.viewport && (w.viewport.style.scrollBehavior = ""), h.current = null;
          })
        }
      )
    }
  );
}), kt = "ScrollAreaThumb", ar = p.forwardRef(
  (e, t) => {
    const { forceMount: n, ...o } = e, r = or(kt, e.__scopeScrollArea);
    return /* @__PURE__ */ a(Te, { present: n || r.hasThumb, children: /* @__PURE__ */ a(Bc, { ref: t, ...o }) });
  }
), Bc = p.forwardRef(
  (e, t) => {
    const { __scopeScrollArea: n, style: o, ...r } = e, s = ue(kt, n), i = or(kt, n), { onThumbPositionChange: l } = i, c = ee(
      t,
      (f) => i.onThumbChange(f)
    ), u = p.useRef(void 0), d = It(() => {
      u.current && (u.current(), u.current = void 0);
    }, 100);
    return p.useEffect(() => {
      const f = s.viewport;
      if (f) {
        const m = () => {
          if (d(), !u.current) {
            const w = jc(f, l);
            u.current = w, l();
          }
        };
        return l(), f.addEventListener("scroll", m), () => f.removeEventListener("scroll", m);
      }
    }, [s.viewport, d, l]), /* @__PURE__ */ a(
      K.div,
      {
        "data-state": i.hasThumb ? "visible" : "hidden",
        ...r,
        ref: c,
        style: {
          width: "var(--radix-scroll-area-thumb-width)",
          height: "var(--radix-scroll-area-thumb-height)",
          ...o
        },
        onPointerDownCapture: X(e.onPointerDownCapture, (f) => {
          const w = f.target.getBoundingClientRect(), S = f.clientX - w.left, b = f.clientY - w.top;
          i.onThumbPointerDown({ x: S, y: b });
        }),
        onPointerUp: X(e.onPointerUp, i.onThumbPointerUp)
      }
    );
  }
);
ar.displayName = kt;
var sn = "ScrollAreaCorner", sr = p.forwardRef(
  (e, t) => {
    const n = ue(sn, e.__scopeScrollArea), o = !!(n.scrollbarX && n.scrollbarY);
    return n.type !== "scroll" && o ? /* @__PURE__ */ a($c, { ...e, ref: t }) : null;
  }
);
sr.displayName = sn;
var $c = p.forwardRef((e, t) => {
  const { __scopeScrollArea: n, ...o } = e, r = ue(sn, n), [s, i] = p.useState(0), [l, c] = p.useState(0), u = !!(s && l);
  return Ye(r.scrollbarX, () => {
    var f;
    const d = ((f = r.scrollbarX) == null ? void 0 : f.offsetHeight) || 0;
    r.onCornerHeightChange(d), c(d);
  }), Ye(r.scrollbarY, () => {
    var f;
    const d = ((f = r.scrollbarY) == null ? void 0 : f.offsetWidth) || 0;
    r.onCornerWidthChange(d), i(d);
  }), u ? /* @__PURE__ */ a(
    K.div,
    {
      ...o,
      ref: t,
      style: {
        width: s,
        height: l,
        position: "absolute",
        right: r.dir === "ltr" ? 0 : void 0,
        left: r.dir === "rtl" ? 0 : void 0,
        bottom: 0,
        ...e.style
      }
    }
  ) : null;
});
function Nt(e) {
  return e ? parseInt(e, 10) : 0;
}
function ir(e, t) {
  const n = e / t;
  return isNaN(n) ? 0 : n;
}
function Dt(e) {
  const t = ir(e.viewport, e.content), n = e.scrollbar.paddingStart + e.scrollbar.paddingEnd, o = (e.scrollbar.size - n) * t;
  return Math.max(o, 18);
}
function Gc(e, t, n, o = "ltr") {
  const r = Dt(n), s = r / 2, i = t || s, l = r - i, c = n.scrollbar.paddingStart + i, u = n.scrollbar.size - n.scrollbar.paddingEnd - l, d = n.content - n.viewport, f = o === "ltr" ? [0, d] : [d * -1, 0];
  return lr([c, u], f)(e);
}
function Wn(e, t, n = "ltr") {
  const o = Dt(t), r = t.scrollbar.paddingStart + t.scrollbar.paddingEnd, s = t.scrollbar.size - r, i = t.content - t.viewport, l = s - o, c = n === "ltr" ? [0, i] : [i * -1, 0], u = on(e, c);
  return lr([0, i], [0, l])(u);
}
function lr(e, t) {
  return (n) => {
    if (e[0] === e[1] || t[0] === t[1]) return t[0];
    const o = (t[1] - t[0]) / (e[1] - e[0]);
    return t[0] + o * (n - e[0]);
  };
}
function cr(e, t) {
  return e > 0 && e < t;
}
var jc = (e, t = () => {
}) => {
  let n = { left: e.scrollLeft, top: e.scrollTop }, o = 0;
  return function r() {
    const s = { left: e.scrollLeft, top: e.scrollTop }, i = n.left !== s.left, l = n.top !== s.top;
    (i || l) && t(), n = s, o = window.requestAnimationFrame(r);
  }(), () => window.cancelAnimationFrame(o);
};
function It(e, t) {
  const n = Ae(e), o = p.useRef(0);
  return p.useEffect(() => () => window.clearTimeout(o.current), []), p.useCallback(() => {
    window.clearTimeout(o.current), o.current = window.setTimeout(n, t);
  }, [n, t]);
}
function Ye(e, t) {
  const n = Ae(t);
  He(() => {
    let o = 0;
    if (e) {
      const r = new ResizeObserver(() => {
        cancelAnimationFrame(o), o = window.requestAnimationFrame(n);
      });
      return r.observe(e), () => {
        window.cancelAnimationFrame(o), r.unobserve(e);
      };
    }
  }, [e, n]);
}
var Hc = Zo, Yc = er, Xc = sr;
function Ie({
  className: e,
  children: t,
  ...n
}) {
  return /* @__PURE__ */ y(
    Hc,
    {
      "data-slot": "scroll-area",
      className: Y("relative", e),
      ...n,
      children: [
        /* @__PURE__ */ a(
          Yc,
          {
            "data-slot": "scroll-area-viewport",
            className: "focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1",
            children: t
          }
        ),
        /* @__PURE__ */ a(Kc, {}),
        /* @__PURE__ */ a(Xc, {})
      ]
    }
  );
}
function Kc({
  className: e,
  orientation: t = "vertical",
  ...n
}) {
  return /* @__PURE__ */ a(
    tr,
    {
      "data-slot": "scroll-area-scrollbar",
      orientation: t,
      className: Y(
        "flex touch-none p-px transition-colors select-none",
        t === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        t === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        e
      ),
      ...n,
      children: /* @__PURE__ */ a(
        ar,
        {
          "data-slot": "scroll-area-thumb",
          className: "bg-border relative flex-1 rounded-full"
        }
      )
    }
  );
}
const dr = ({
  endpoint: e,
  onFileSelect: t,
  emptyMessage: n = "No files available."
}) => {
  const [o, r] = ce([]), [s, i] = ce(!1), [l, c] = ce("");
  return oe(() => {
    (async () => {
      i(!0);
      try {
        const d = await fetch(e);
        if (console.log(`Fetching from ${e}:`, d), !d.ok)
          throw new Error(`HTTP error! Status: ${d.status}`);
        const f = await d.json();
        console.log(`Files from ${e}:`, f), r(f);
      } catch (d) {
        console.error(`Error fetching files from ${e}:`, d), c(d instanceof Error ? d.message : String(d));
      } finally {
        i(!1);
      }
    })();
  }, [e]), /* @__PURE__ */ y("div", { children: [
    s && /* @__PURE__ */ a("p", { children: "Loading List..." }),
    l && /* @__PURE__ */ y("p", { style: { color: "red" }, children: [
      "Error: ",
      l
    ] }),
    !s && !l && (o.length > 0 ? /* @__PURE__ */ a("ul", { className: "space-y-1", children: o.map((u, d) => /* @__PURE__ */ a(
      "li",
      {
        className: "cursor-pointer px-3 py-2 rounded-md text-sm hover:bg-accent hover:text-accent-foreground transition-colors",
        onClick: () => t(u),
        children: u.filename
      },
      d
    )) }) : /* @__PURE__ */ a("p", { children: n }))
  ] });
};
function qc({ onFileSelect: e }) {
  return /* @__PURE__ */ y("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ y("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ a("h2", { className: "text-lg font-semibold", children: "Backend: NiiVue Documents" }),
      /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground", children: "Load complete scenes and visualizations" })
    ] }),
    /* @__PURE__ */ a(Ie, { className: "flex-1 min-h-0", children: /* @__PURE__ */ a("div", { className: "p-4 pb-6", children: /* @__PURE__ */ a(
      dr,
      {
        endpoint: fe("nvd"),
        onFileSelect: e,
        emptyMessage: "No niivue documents available."
      }
    ) }) })
  ] });
}
function Jc({ onFileSelect: e }) {
  return /* @__PURE__ */ y("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ y("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ a("h2", { className: "text-lg font-semibold", children: "Backend: Imaging Data" }),
      /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground", children: "Add individual volumes to the current scene" })
    ] }),
    /* @__PURE__ */ a(Ie, { className: "flex-1 min-h-0", children: /* @__PURE__ */ a("div", { className: "p-4 pb-6", children: /* @__PURE__ */ a(
      dr,
      {
        endpoint: fe("vol"),
        onFileSelect: e,
        emptyMessage: "No imaging files available."
      }
    ) }) })
  ] });
}
var Zc = [
  "a",
  "button",
  "div",
  "form",
  "h2",
  "h3",
  "img",
  "input",
  "label",
  "li",
  "nav",
  "ol",
  "p",
  "select",
  "span",
  "svg",
  "ul"
], Qc = Zc.reduce((e, t) => {
  const n = /* @__PURE__ */ Co(`Primitive.${t}`), o = p.forwardRef((r, s) => {
    const { asChild: i, ...l } = r, c = i ? n : t;
    return typeof window < "u" && (window[Symbol.for("radix-ui")] = !0), /* @__PURE__ */ a(c, { ...l, ref: s });
  });
  return o.displayName = `Primitive.${t}`, { ...e, [t]: o };
}, {}), ed = "Label", ur = p.forwardRef((e, t) => /* @__PURE__ */ a(
  Qc.label,
  {
    ...e,
    ref: t,
    onMouseDown: (n) => {
      var r;
      n.target.closest("button, input, select, textarea") || ((r = e.onMouseDown) == null || r.call(e, n), !n.defaultPrevented && n.detail > 1 && n.preventDefault());
    }
  }
));
ur.displayName = ed;
var td = ur;
function G({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ a(
    td,
    {
      "data-slot": "label",
      className: Y(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        e
      ),
      ...t
    }
  );
}
function ln(e) {
  const t = p.useRef({ value: e, previous: e });
  return p.useMemo(() => (t.current.value !== e && (t.current.previous = t.current.value, t.current.value = e), t.current.previous), [e]);
}
function cn(e) {
  const [t, n] = p.useState(void 0);
  return He(() => {
    if (e) {
      n({ width: e.offsetWidth, height: e.offsetHeight });
      const o = new ResizeObserver((r) => {
        if (!Array.isArray(r) || !r.length)
          return;
        const s = r[0];
        let i, l;
        if ("borderBoxSize" in s) {
          const c = s.borderBoxSize, u = Array.isArray(c) ? c[0] : c;
          i = u.inlineSize, l = u.blockSize;
        } else
          i = e.offsetWidth, l = e.offsetHeight;
        n({ width: i, height: l });
      });
      return o.observe(e, { box: "border-box" }), () => o.unobserve(e);
    } else
      n(void 0);
  }, [e]), t;
}
var mr = ["PageUp", "PageDown"], fr = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], hr = {
  "from-left": ["Home", "PageDown", "ArrowDown", "ArrowLeft"],
  "from-right": ["Home", "PageDown", "ArrowDown", "ArrowRight"],
  "from-bottom": ["Home", "PageDown", "ArrowDown", "ArrowLeft"],
  "from-top": ["Home", "PageDown", "ArrowUp", "ArrowLeft"]
}, Ze = "Slider", [jt, nd, od] = ko(Ze), [pr] = we(Ze, [
  od
]), [rd, Rt] = pr(Ze), gr = p.forwardRef(
  (e, t) => {
    const {
      name: n,
      min: o = 0,
      max: r = 100,
      step: s = 1,
      orientation: i = "horizontal",
      disabled: l = !1,
      minStepsBetweenThumbs: c = 0,
      defaultValue: u = [o],
      value: d,
      onValueChange: f = () => {
      },
      onValueCommit: m = () => {
      },
      inverted: w = !1,
      form: S,
      ...b
    } = e, v = p.useRef(/* @__PURE__ */ new Set()), h = p.useRef(0), N = i === "horizontal" ? ad : sd, [k = [], E] = Re({
      prop: d,
      defaultProp: u,
      onChange: (V) => {
        var O;
        (O = [...v.current][h.current]) == null || O.focus(), f(V);
      }
    }), U = p.useRef(k);
    function F(V) {
      const R = ud(k, V);
      M(V, R);
    }
    function C(V) {
      M(V, h.current);
    }
    function x() {
      const V = U.current[h.current];
      k[h.current] !== V && m(k);
    }
    function M(V, R, { commit: O } = { commit: !1 }) {
      const H = pd(s), D = gd(Math.round((V - o) / s) * s + o, H), P = on(D, [o, r]);
      E((W = []) => {
        const T = cd(W, P, R);
        if (hd(T, c * s)) {
          h.current = T.indexOf(P);
          const re = String(T) !== String(W);
          return re && O && m(T), re ? T : W;
        } else
          return W;
      });
    }
    return /* @__PURE__ */ a(
      rd,
      {
        scope: e.__scopeSlider,
        name: n,
        disabled: l,
        min: o,
        max: r,
        valueIndexToChangeRef: h,
        thumbs: v.current,
        values: k,
        orientation: i,
        form: S,
        children: /* @__PURE__ */ a(jt.Provider, { scope: e.__scopeSlider, children: /* @__PURE__ */ a(jt.Slot, { scope: e.__scopeSlider, children: /* @__PURE__ */ a(
          N,
          {
            "aria-disabled": l,
            "data-disabled": l ? "" : void 0,
            ...b,
            ref: t,
            onPointerDown: X(b.onPointerDown, () => {
              l || (U.current = k);
            }),
            min: o,
            max: r,
            inverted: w,
            onSlideStart: l ? void 0 : F,
            onSlideMove: l ? void 0 : C,
            onSlideEnd: l ? void 0 : x,
            onHomeKeyDown: () => !l && M(o, 0, { commit: !0 }),
            onEndKeyDown: () => !l && M(r, k.length - 1, { commit: !0 }),
            onStepKeyDown: ({ event: V, direction: R }) => {
              if (!l) {
                const D = mr.includes(V.key) || V.shiftKey && fr.includes(V.key) ? 10 : 1, P = h.current, W = k[P], T = s * D * R;
                M(W + T, P, { commit: !0 });
              }
            }
          }
        ) }) })
      }
    );
  }
);
gr.displayName = Ze;
var [vr, br] = pr(Ze, {
  startEdge: "left",
  endEdge: "right",
  size: "width",
  direction: 1
}), ad = p.forwardRef(
  (e, t) => {
    const {
      min: n,
      max: o,
      dir: r,
      inverted: s,
      onSlideStart: i,
      onSlideMove: l,
      onSlideEnd: c,
      onStepKeyDown: u,
      ...d
    } = e, [f, m] = p.useState(null), w = ee(t, (N) => m(N)), S = p.useRef(void 0), b = qe(r), v = b === "ltr", h = v && !s || !v && s;
    function g(N) {
      const k = S.current || f.getBoundingClientRect(), E = [0, k.width], F = dn(E, h ? [n, o] : [o, n]);
      return S.current = k, F(N - k.left);
    }
    return /* @__PURE__ */ a(
      vr,
      {
        scope: e.__scopeSlider,
        startEdge: h ? "left" : "right",
        endEdge: h ? "right" : "left",
        direction: h ? 1 : -1,
        size: "width",
        children: /* @__PURE__ */ a(
          wr,
          {
            dir: b,
            "data-orientation": "horizontal",
            ...d,
            ref: w,
            style: {
              ...d.style,
              "--radix-slider-thumb-transform": "translateX(-50%)"
            },
            onSlideStart: (N) => {
              const k = g(N.clientX);
              i == null || i(k);
            },
            onSlideMove: (N) => {
              const k = g(N.clientX);
              l == null || l(k);
            },
            onSlideEnd: () => {
              S.current = void 0, c == null || c();
            },
            onStepKeyDown: (N) => {
              const E = hr[h ? "from-left" : "from-right"].includes(N.key);
              u == null || u({ event: N, direction: E ? -1 : 1 });
            }
          }
        )
      }
    );
  }
), sd = p.forwardRef(
  (e, t) => {
    const {
      min: n,
      max: o,
      inverted: r,
      onSlideStart: s,
      onSlideMove: i,
      onSlideEnd: l,
      onStepKeyDown: c,
      ...u
    } = e, d = p.useRef(null), f = ee(t, d), m = p.useRef(void 0), w = !r;
    function S(b) {
      const v = m.current || d.current.getBoundingClientRect(), h = [0, v.height], N = dn(h, w ? [o, n] : [n, o]);
      return m.current = v, N(b - v.top);
    }
    return /* @__PURE__ */ a(
      vr,
      {
        scope: e.__scopeSlider,
        startEdge: w ? "bottom" : "top",
        endEdge: w ? "top" : "bottom",
        size: "height",
        direction: w ? 1 : -1,
        children: /* @__PURE__ */ a(
          wr,
          {
            "data-orientation": "vertical",
            ...u,
            ref: f,
            style: {
              ...u.style,
              "--radix-slider-thumb-transform": "translateY(50%)"
            },
            onSlideStart: (b) => {
              const v = S(b.clientY);
              s == null || s(v);
            },
            onSlideMove: (b) => {
              const v = S(b.clientY);
              i == null || i(v);
            },
            onSlideEnd: () => {
              m.current = void 0, l == null || l();
            },
            onStepKeyDown: (b) => {
              const h = hr[w ? "from-bottom" : "from-top"].includes(b.key);
              c == null || c({ event: b, direction: h ? -1 : 1 });
            }
          }
        )
      }
    );
  }
), wr = p.forwardRef(
  (e, t) => {
    const {
      __scopeSlider: n,
      onSlideStart: o,
      onSlideMove: r,
      onSlideEnd: s,
      onHomeKeyDown: i,
      onEndKeyDown: l,
      onStepKeyDown: c,
      ...u
    } = e, d = Rt(Ze, n);
    return /* @__PURE__ */ a(
      K.span,
      {
        ...u,
        ref: t,
        onKeyDown: X(e.onKeyDown, (f) => {
          f.key === "Home" ? (i(f), f.preventDefault()) : f.key === "End" ? (l(f), f.preventDefault()) : mr.concat(fr).includes(f.key) && (c(f), f.preventDefault());
        }),
        onPointerDown: X(e.onPointerDown, (f) => {
          const m = f.target;
          m.setPointerCapture(f.pointerId), f.preventDefault(), d.thumbs.has(m) ? m.focus() : o(f);
        }),
        onPointerMove: X(e.onPointerMove, (f) => {
          f.target.hasPointerCapture(f.pointerId) && r(f);
        }),
        onPointerUp: X(e.onPointerUp, (f) => {
          const m = f.target;
          m.hasPointerCapture(f.pointerId) && (m.releasePointerCapture(f.pointerId), s(f));
        })
      }
    );
  }
), yr = "SliderTrack", xr = p.forwardRef(
  (e, t) => {
    const { __scopeSlider: n, ...o } = e, r = Rt(yr, n);
    return /* @__PURE__ */ a(
      K.span,
      {
        "data-disabled": r.disabled ? "" : void 0,
        "data-orientation": r.orientation,
        ...o,
        ref: t
      }
    );
  }
);
xr.displayName = yr;
var Ht = "SliderRange", Cr = p.forwardRef(
  (e, t) => {
    const { __scopeSlider: n, ...o } = e, r = Rt(Ht, n), s = br(Ht, n), i = p.useRef(null), l = ee(t, i), c = r.values.length, u = r.values.map(
      (m) => Nr(m, r.min, r.max)
    ), d = c > 1 ? Math.min(...u) : 0, f = 100 - Math.max(...u);
    return /* @__PURE__ */ a(
      K.span,
      {
        "data-orientation": r.orientation,
        "data-disabled": r.disabled ? "" : void 0,
        ...o,
        ref: l,
        style: {
          ...e.style,
          [s.startEdge]: d + "%",
          [s.endEdge]: f + "%"
        }
      }
    );
  }
);
Cr.displayName = Ht;
var Yt = "SliderThumb", Sr = p.forwardRef(
  (e, t) => {
    const n = nd(e.__scopeSlider), [o, r] = p.useState(null), s = ee(t, (l) => r(l)), i = p.useMemo(
      () => o ? n().findIndex((l) => l.ref.current === o) : -1,
      [n, o]
    );
    return /* @__PURE__ */ a(id, { ...e, ref: s, index: i });
  }
), id = p.forwardRef(
  (e, t) => {
    const { __scopeSlider: n, index: o, name: r, ...s } = e, i = Rt(Yt, n), l = br(Yt, n), [c, u] = p.useState(null), d = ee(t, (g) => u(g)), f = c ? i.form || !!c.closest("form") : !0, m = cn(c), w = i.values[o], S = w === void 0 ? 0 : Nr(w, i.min, i.max), b = dd(o, i.values.length), v = m == null ? void 0 : m[l.size], h = v ? md(v, S, l.direction) : 0;
    return p.useEffect(() => {
      if (c)
        return i.thumbs.add(c), () => {
          i.thumbs.delete(c);
        };
    }, [c, i.thumbs]), /* @__PURE__ */ y(
      "span",
      {
        style: {
          transform: "var(--radix-slider-thumb-transform)",
          position: "absolute",
          [l.startEdge]: `calc(${S}% + ${h}px)`
        },
        children: [
          /* @__PURE__ */ a(jt.ItemSlot, { scope: e.__scopeSlider, children: /* @__PURE__ */ a(
            K.span,
            {
              role: "slider",
              "aria-label": e["aria-label"] || b,
              "aria-valuemin": i.min,
              "aria-valuenow": w,
              "aria-valuemax": i.max,
              "aria-orientation": i.orientation,
              "data-orientation": i.orientation,
              "data-disabled": i.disabled ? "" : void 0,
              tabIndex: i.disabled ? void 0 : 0,
              ...s,
              ref: d,
              style: w === void 0 ? { display: "none" } : e.style,
              onFocus: X(e.onFocus, () => {
                i.valueIndexToChangeRef.current = o;
              })
            }
          ) }),
          f && /* @__PURE__ */ a(
            kr,
            {
              name: r ?? (i.name ? i.name + (i.values.length > 1 ? "[]" : "") : void 0),
              form: i.form,
              value: w
            },
            o
          )
        ]
      }
    );
  }
);
Sr.displayName = Yt;
var ld = "RadioBubbleInput", kr = p.forwardRef(
  ({ __scopeSlider: e, value: t, ...n }, o) => {
    const r = p.useRef(null), s = ee(r, o), i = ln(t);
    return p.useEffect(() => {
      const l = r.current;
      if (!l) return;
      const c = window.HTMLInputElement.prototype, d = Object.getOwnPropertyDescriptor(c, "value").set;
      if (i !== t && d) {
        const f = new Event("input", { bubbles: !0 });
        d.call(l, t), l.dispatchEvent(f);
      }
    }, [i, t]), /* @__PURE__ */ a(
      K.input,
      {
        style: { display: "none" },
        ...n,
        ref: s,
        defaultValue: t
      }
    );
  }
);
kr.displayName = ld;
function cd(e = [], t, n) {
  const o = [...e];
  return o[n] = t, o.sort((r, s) => r - s);
}
function Nr(e, t, n) {
  const s = 100 / (n - t) * (e - t);
  return on(s, [0, 100]);
}
function dd(e, t) {
  return t > 2 ? `Value ${e + 1} of ${t}` : t === 2 ? ["Minimum", "Maximum"][e] : void 0;
}
function ud(e, t) {
  if (e.length === 1) return 0;
  const n = e.map((r) => Math.abs(r - t)), o = Math.min(...n);
  return n.indexOf(o);
}
function md(e, t, n) {
  const o = e / 2, s = dn([0, 50], [0, o]);
  return (o - s(t) * n) * n;
}
function fd(e) {
  return e.slice(0, -1).map((t, n) => e[n + 1] - t);
}
function hd(e, t) {
  if (t > 0) {
    const n = fd(e);
    return Math.min(...n) >= t;
  }
  return !0;
}
function dn(e, t) {
  return (n) => {
    if (e[0] === e[1] || t[0] === t[1]) return t[0];
    const o = (t[1] - t[0]) / (e[1] - e[0]);
    return t[0] + o * (n - e[0]);
  };
}
function pd(e) {
  return (String(e).split(".")[1] || "").length;
}
function gd(e, t) {
  const n = Math.pow(10, t);
  return Math.round(e * n) / n;
}
var vd = gr, bd = xr, wd = Cr, yd = Sr;
function xd({
  className: e,
  defaultValue: t,
  value: n,
  min: o = 0,
  max: r = 100,
  ...s
}) {
  const i = p.useMemo(
    () => Array.isArray(n) ? n : Array.isArray(t) ? t : [o, r],
    [n, t, o, r]
  );
  return /* @__PURE__ */ y(
    vd,
    {
      "data-slot": "slider",
      defaultValue: t,
      value: n,
      min: o,
      max: r,
      className: Y(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        e
      ),
      ...s,
      children: [
        /* @__PURE__ */ a(
          bd,
          {
            "data-slot": "slider-track",
            className: Y(
              "bg-muted relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
            ),
            children: /* @__PURE__ */ a(
              wd,
              {
                "data-slot": "slider-range",
                className: Y(
                  "bg-primary absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
                )
              }
            )
          }
        ),
        Array.from({ length: i.length }, (l, c) => /* @__PURE__ */ a(
          yd,
          {
            "data-slot": "slider-thumb",
            className: "border-primary bg-background ring-ring/50 block size-4 shrink-0 rounded-full border shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
          },
          c
        ))
      ]
    }
  );
}
const Le = p.forwardRef(
  ({ className: e, type: t, ...n }, o) => /* @__PURE__ */ a(
    "input",
    {
      type: t,
      className: Y(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ref: o,
      ...n
    }
  )
);
Le.displayName = "Input";
const te = p.forwardRef(
  ({
    label: e,
    value: t,
    onValueChange: n,
    min: o = 0,
    max: r = 100,
    step: s = 1,
    decimalPlaces: i = 2,
    className: l,
    disabled: c = !1,
    ...u
  }, d) => {
    const [f, m] = p.useState(t), w = p.useRef(void 0), S = (N) => Number(N.toFixed(i));
    p.useEffect(() => {
      m(t);
    }, [t]);
    const b = p.useCallback((N) => {
      w.current && clearTimeout(w.current), w.current = setTimeout(() => {
        n(N);
      }, 50);
    }, [n]), v = (N) => {
      const k = N[0];
      m(k), b(k);
    }, h = (N) => {
      const k = parseFloat(N.target.value);
      if (!isNaN(k)) {
        const E = Math.min(Math.max(k, o), r);
        m(E), b(E);
      }
    }, g = (N) => {
      const k = parseFloat(N.target.value);
      (isNaN(k) || k < o || k > r) && (m(t), N.target.value = t.toString());
    };
    return /* @__PURE__ */ y(
      "div",
      {
        ref: d,
        className: Y("space-y-2", l),
        ...u,
        children: [
          /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: e }),
          /* @__PURE__ */ y("div", { className: "flex items-center space-x-3", children: [
            /* @__PURE__ */ a(
              xd,
              {
                value: [f],
                onValueChange: v,
                min: o,
                max: r,
                step: s,
                disabled: c,
                className: "flex-1"
              }
            ),
            /* @__PURE__ */ a(
              Le,
              {
                type: "number",
                value: S(f),
                onChange: h,
                onBlur: g,
                min: o,
                max: r,
                step: s,
                disabled: c,
                className: "w-20 text-center"
              }
            )
          ] })
        ]
      }
    );
  }
);
te.displayName = "LabeledSliderWithInput";
const be = p.forwardRef(
  ({ className: e, children: t, ...n }, o) => /* @__PURE__ */ a(
    "select",
    {
      className: Y(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ref: o,
      ...n,
      children: t
    }
  )
);
be.displayName = "Select";
function Cd({
  nvRef: e,
  serverlessMode: t,
  getVolumes: n,
  onToggleVisibility: o,
  onEditVolume: r,
  canEditVolume: s,
  onRemoveVolume: i,
  onAddMoreFiles: l,
  onCreateDrawingLayer: c,
  onSaveScene: u,
  onOpacityChange: d,
  onFrameChange: f,
  onContrastMinChange: m,
  onContrastMaxChange: w,
  onColormapChange: S,
  onMoveVolumeUp: b,
  onMoveVolumeDown: v
}) {
  var U;
  const h = A((F) => F.currentImageIndex), g = A(
    (F) => F.setCurrentImageIndex
  ), N = A((F) => F.drawingOptions), k = n(), E = h !== null ? k[h] : null;
  return /* @__PURE__ */ y("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ y("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ a("h2", { className: "text-lg font-semibold", children: "Volumetric Details" }),
      /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground", children: "Manage volumes and adjust properties" })
    ] }),
    /* @__PURE__ */ y(Ie, { className: "max-h-[50%] min-h-0", children: [
      k.length > 0 ? /* @__PURE__ */ a("div", { className: "grid gap-2 p-4", children: k.map((F, C) => /* @__PURE__ */ y(
        "div",
        {
          className: Y(
            "flex items-center gap-2 p-2 rounded-md cursor-pointer",
            h === C ? "bg-muted" : "hover:bg-muted/50"
          ),
          onClick: () => g(C),
          children: [
            /* @__PURE__ */ a("div", { className: "flex-shrink-0", children: /* @__PURE__ */ a(
              B,
              {
                variant: "ghost",
                size: "sm",
                className: "h-6 w-6 p-0",
                onClick: (x) => {
                  x.stopPropagation(), F.id && o(F.id);
                },
                children: F.visible !== !1 ? /* @__PURE__ */ a(Jt, { className: "h-3 w-3" }) : /* @__PURE__ */ a(qt, { className: "h-3 w-3 opacity-50" })
              }
            ) }),
            /* @__PURE__ */ a("div", { className: "flex-1 w-0", children: /* @__PURE__ */ a("p", { className: "text-sm font-medium break-words", children: F.name || `Volume ${C + 1}` }) }),
            /* @__PURE__ */ y("div", { className: "flex-shrink-0 flex gap-1", children: [
              /* @__PURE__ */ a(
                B,
                {
                  variant: "ghost",
                  size: "sm",
                  className: "h-6 w-6 p-0 hover:bg-blue-100 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent",
                  onClick: (x) => {
                    x.stopPropagation(), r(C);
                  },
                  disabled: !s(C),
                  title: s(C) ? "Edit as drawing" : "Cannot edit - must match background dimensions and affine",
                  children: /* @__PURE__ */ a(dl, { className: "h-3 w-3" })
                }
              ),
              /* @__PURE__ */ a(
                B,
                {
                  variant: "ghost",
                  size: "sm",
                  className: "h-6 w-6 p-0 hover:bg-destructive hover:text-destructive-foreground",
                  onClick: (x) => {
                    x.stopPropagation(), i(C);
                  },
                  title: "Delete volume",
                  children: /* @__PURE__ */ a(xt, { className: "h-3 w-3" })
                }
              )
            ] })
          ]
        },
        F.id
      )) }) : /* @__PURE__ */ y("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground", children: [
        /* @__PURE__ */ a(Li, { className: "h-8 w-8 mb-2" }),
        /* @__PURE__ */ a("p", { children: "No images" })
      ] }),
      /* @__PURE__ */ y("div", { className: "p-2 border-t space-y-2", children: [
        /* @__PURE__ */ y(
          B,
          {
            variant: "outline",
            size: "sm",
            className: "w-full",
            onClick: l,
            children: [
              /* @__PURE__ */ a(at, { className: "mr-2 h-4 w-4" }),
              "Load volumes"
            ]
          }
        ),
        /* @__PURE__ */ y(
          B,
          {
            variant: "outline",
            size: "sm",
            className: "w-full",
            onClick: c,
            disabled: N.enabled || k.length === 0,
            children: [
              /* @__PURE__ */ a(Zt, { className: "mr-2 h-4 w-4" }),
              "Create empty drawing layer"
            ]
          }
        ),
        /* @__PURE__ */ y("div", { className: "flex gap-2", children: [
          /* @__PURE__ */ y(
            B,
            {
              variant: "outline",
              size: "sm",
              className: "flex-1",
              onClick: () => u(!1),
              disabled: k.length === 0 || N.enabled || t,
              children: [
                /* @__PURE__ */ a(wo, { className: "mr-2 h-4 w-4" }),
                "Save"
              ]
            }
          ),
          /* @__PURE__ */ y(
            B,
            {
              variant: "outline",
              size: "sm",
              className: "flex-1",
              onClick: () => u(!0),
              disabled: k.length === 0 || N.enabled || wt.downloadDisabled,
              title: wt.downloadDisabled ? "Download is disabled in this deployment" : void 0,
              children: [
                /* @__PURE__ */ a(Mi, { className: "mr-2 h-4 w-4" }),
                "Download"
              ]
            }
          )
        ] })
      ] })
    ] }),
    /* @__PURE__ */ a(Ie, { className: "flex-1 min-h-0", children: E ? /* @__PURE__ */ y("div", { className: "grid gap-4 p-4", children: [
      /* @__PURE__ */ y("div", { className: "flex gap-2", children: [
        /* @__PURE__ */ y(
          B,
          {
            variant: "outline",
            size: "sm",
            className: "flex-1",
            onClick: b,
            disabled: h === null || h === 0,
            children: [
              /* @__PURE__ */ a(pi, { className: "mr-2 h-4 w-4" }),
              "Move up"
            ]
          }
        ),
        /* @__PURE__ */ y(
          B,
          {
            variant: "outline",
            size: "sm",
            className: "flex-1",
            onClick: v,
            disabled: h === null || h === k.length - 1,
            children: [
              /* @__PURE__ */ a(fi, { className: "mr-2 h-4 w-4" }),
              "Move down"
            ]
          }
        )
      ] }),
      (E.nFrame4D || 1) > 1 && /* @__PURE__ */ a(
        te,
        {
          label: "Frame",
          value: E.frame4D ?? 0,
          onValueChange: f,
          min: 0,
          max: (E.nFrame4D || 1) - 1,
          step: 1
        }
      ),
      /* @__PURE__ */ a(
        te,
        {
          label: "Opacity",
          value: E.opacity ?? 1,
          onValueChange: d,
          min: 0,
          max: 1,
          step: 0.01
        }
      ),
      /* @__PURE__ */ a(
        te,
        {
          label: "Contrast Min",
          value: E.calMin ?? 0,
          onValueChange: m,
          min: E.globalMin ?? 0,
          max: E.globalMax ?? 255,
          step: 0.1,
          decimalPlaces: 1
        }
      ),
      /* @__PURE__ */ a(
        te,
        {
          label: "Contrast Max",
          value: E.calMax ?? 100,
          onValueChange: w,
          min: E.globalMin ?? 0,
          max: E.globalMax ?? 255,
          step: 0.1,
          decimalPlaces: 1
        }
      ),
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Colormap" }),
        /* @__PURE__ */ a(
          be,
          {
            value: E.colormap || "gray",
            onChange: S,
            children: (U = e.current) == null ? void 0 : U.colormaps.map((F) => /* @__PURE__ */ a("option", { value: F, children: F }, F))
          }
        )
      ] })
    ] }) : /* @__PURE__ */ a("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground" }) })
  ] });
}
var Pt = "Checkbox", [Sd] = we(Pt), [kd, un] = Sd(Pt);
function Nd(e) {
  const {
    __scopeCheckbox: t,
    checked: n,
    children: o,
    defaultChecked: r,
    disabled: s,
    form: i,
    name: l,
    onCheckedChange: c,
    required: u,
    value: d = "on",
    // @ts-expect-error
    internal_do_not_use_render: f
  } = e, [m, w] = Re({
    prop: n,
    defaultProp: r ?? !1,
    onChange: c,
    caller: Pt
  }), [S, b] = p.useState(null), [v, h] = p.useState(null), g = p.useRef(!1), N = S ? !!i || !!S.closest("form") : (
    // We set this to true by default so that events bubble to forms without JS (SSR)
    !0
  ), k = {
    checked: m,
    disabled: s,
    setChecked: w,
    control: S,
    setControl: b,
    name: l,
    form: i,
    value: d,
    hasConsumerStoppedPropagationRef: g,
    required: u,
    defaultChecked: Ee(r) ? !1 : r,
    isFormControl: N,
    bubbleInput: v,
    setBubbleInput: h
  };
  return /* @__PURE__ */ a(
    kd,
    {
      scope: t,
      ...k,
      children: Ad(f) ? f(k) : o
    }
  );
}
var Ar = "CheckboxTrigger", Mr = p.forwardRef(
  ({ __scopeCheckbox: e, onKeyDown: t, onClick: n, ...o }, r) => {
    const {
      control: s,
      value: i,
      disabled: l,
      checked: c,
      required: u,
      setControl: d,
      setChecked: f,
      hasConsumerStoppedPropagationRef: m,
      isFormControl: w,
      bubbleInput: S
    } = un(Ar, e), b = ee(r, d), v = p.useRef(c);
    return p.useEffect(() => {
      const h = s == null ? void 0 : s.form;
      if (h) {
        const g = () => f(v.current);
        return h.addEventListener("reset", g), () => h.removeEventListener("reset", g);
      }
    }, [s, f]), /* @__PURE__ */ a(
      K.button,
      {
        type: "button",
        role: "checkbox",
        "aria-checked": Ee(c) ? "mixed" : c,
        "aria-required": u,
        "data-state": Tr(c),
        "data-disabled": l ? "" : void 0,
        disabled: l,
        value: i,
        ...o,
        ref: b,
        onKeyDown: X(t, (h) => {
          h.key === "Enter" && h.preventDefault();
        }),
        onClick: X(n, (h) => {
          f((g) => Ee(g) ? !0 : !g), S && w && (m.current = h.isPropagationStopped(), m.current || h.stopPropagation());
        })
      }
    );
  }
);
Mr.displayName = Ar;
var Er = p.forwardRef(
  (e, t) => {
    const {
      __scopeCheckbox: n,
      name: o,
      checked: r,
      defaultChecked: s,
      required: i,
      disabled: l,
      value: c,
      onCheckedChange: u,
      form: d,
      ...f
    } = e;
    return /* @__PURE__ */ a(
      Nd,
      {
        __scopeCheckbox: n,
        checked: r,
        defaultChecked: s,
        disabled: l,
        required: i,
        onCheckedChange: u,
        name: o,
        form: d,
        value: c,
        internal_do_not_use_render: ({ isFormControl: m }) => /* @__PURE__ */ y(De, { children: [
          /* @__PURE__ */ a(
            Mr,
            {
              ...f,
              ref: t,
              __scopeCheckbox: n
            }
          ),
          m && /* @__PURE__ */ a(
            Pr,
            {
              __scopeCheckbox: n
            }
          )
        ] })
      }
    );
  }
);
Er.displayName = Pt;
var Dr = "CheckboxIndicator", Ir = p.forwardRef(
  (e, t) => {
    const { __scopeCheckbox: n, forceMount: o, ...r } = e, s = un(Dr, n);
    return /* @__PURE__ */ a(
      Te,
      {
        present: o || Ee(s.checked) || s.checked === !0,
        children: /* @__PURE__ */ a(
          K.span,
          {
            "data-state": Tr(s.checked),
            "data-disabled": s.disabled ? "" : void 0,
            ...r,
            ref: t,
            style: { pointerEvents: "none", ...e.style }
          }
        )
      }
    );
  }
);
Ir.displayName = Dr;
var Rr = "CheckboxBubbleInput", Pr = p.forwardRef(
  ({ __scopeCheckbox: e, ...t }, n) => {
    const {
      control: o,
      hasConsumerStoppedPropagationRef: r,
      checked: s,
      defaultChecked: i,
      required: l,
      disabled: c,
      name: u,
      value: d,
      form: f,
      bubbleInput: m,
      setBubbleInput: w
    } = un(Rr, e), S = ee(n, w), b = ln(s), v = cn(o);
    p.useEffect(() => {
      const g = m;
      if (!g) return;
      const N = window.HTMLInputElement.prototype, E = Object.getOwnPropertyDescriptor(
        N,
        "checked"
      ).set, U = !r.current;
      if (b !== s && E) {
        const F = new Event("click", { bubbles: U });
        g.indeterminate = Ee(s), E.call(g, Ee(s) ? !1 : s), g.dispatchEvent(F);
      }
    }, [m, b, s, r]);
    const h = p.useRef(Ee(s) ? !1 : s);
    return /* @__PURE__ */ a(
      K.input,
      {
        type: "checkbox",
        "aria-hidden": !0,
        defaultChecked: i ?? h.current,
        required: l,
        disabled: c,
        name: u,
        value: d,
        form: f,
        ...t,
        tabIndex: -1,
        ref: S,
        style: {
          ...t.style,
          ...v,
          position: "absolute",
          pointerEvents: "none",
          opacity: 0,
          margin: 0,
          // We transform because the input is absolutely positioned but we have
          // rendered it **after** the button. This pulls it back to sit on top
          // of the button.
          transform: "translateX(-100%)"
        }
      }
    );
  }
);
Pr.displayName = Rr;
function Ad(e) {
  return typeof e == "function";
}
function Ee(e) {
  return e === "indeterminate";
}
function Tr(e) {
  return Ee(e) ? "indeterminate" : e ? "checked" : "unchecked";
}
function se({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ a(
    Er,
    {
      "data-slot": "checkbox",
      className: Y(
        "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ...t,
      children: /* @__PURE__ */ a(
        Ir,
        {
          "data-slot": "checkbox-indicator",
          className: "flex items-center justify-center text-current transition-none",
          children: /* @__PURE__ */ a(ui, { className: "size-3.5" })
        }
      )
    }
  );
}
function Md({
  nvRef: e,
  onToggleVisibility: t,
  onRemoveSurface: n,
  onAddSurfaceFiles: o,
  onOpacityChange: r,
  onColorChange: s,
  onShaderChange: i,
  getLayers: l,
  onAddLayerFiles: c,
  onRemoveLayer: u,
  onLayerOpacityChange: d,
  onLayerCalMinChange: f,
  onLayerCalMaxChange: m,
  onLayerColormapChange: w,
  onLayerUseNegativeCmapChange: S
}) {
  var U, F, C, x, M, V;
  const b = A((R) => R.surfaces), v = A((R) => R.currentSurfaceIndex), h = A(
    (R) => R.setCurrentSurfaceIndex
  ), g = A((R) => R.selectedLayerIndex), N = A(
    (R) => R.setSelectedLayerIndex
  ), k = l(), E = g !== null ? k[g] : null;
  return /* @__PURE__ */ y("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ y("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ a("h2", { className: "text-lg font-semibold", children: "Surface Details" }),
      /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground", children: "Manage surfaces and adjust properties" })
    ] }),
    /* @__PURE__ */ y(Ie, { className: "max-h-[50%] min-h-0", children: [
      b.length > 0 ? /* @__PURE__ */ a("div", { className: "grid gap-2 p-4", children: b.map((R, O) => /* @__PURE__ */ y(
        "div",
        {
          className: Y(
            "flex items-center gap-2 p-2 rounded-md cursor-pointer",
            v === O ? "bg-muted" : "hover:bg-muted/50"
          ),
          onClick: () => h(O),
          children: [
            /* @__PURE__ */ a("div", { className: "flex-shrink-0", children: /* @__PURE__ */ a(
              B,
              {
                variant: "ghost",
                size: "sm",
                className: "h-6 w-6 p-0",
                onClick: (H) => {
                  H.stopPropagation(), t(O);
                },
                children: R.visible ? /* @__PURE__ */ a(Jt, { className: "h-3 w-3" }) : /* @__PURE__ */ a(qt, { className: "h-3 w-3 opacity-50" })
              }
            ) }),
            /* @__PURE__ */ a("div", { className: "flex-1 w-0", children: /* @__PURE__ */ a("p", { className: "text-sm font-medium break-words", children: R.name }) }),
            /* @__PURE__ */ a("div", { className: "flex-shrink-0 flex gap-1", children: /* @__PURE__ */ a(
              B,
              {
                variant: "ghost",
                size: "sm",
                className: "h-6 w-6 p-0 hover:bg-destructive hover:text-destructive-foreground",
                onClick: (H) => {
                  H.stopPropagation(), n(O);
                },
                title: "Delete surface",
                children: /* @__PURE__ */ a(xt, { className: "h-3 w-3" })
              }
            ) })
          ]
        },
        R.id
      )) }) : /* @__PURE__ */ y("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground", children: [
        /* @__PURE__ */ a(At, { className: "h-8 w-8 mb-2" }),
        /* @__PURE__ */ a("p", { children: "No surfaces" })
      ] }),
      /* @__PURE__ */ a("div", { className: "p-2 border-t space-y-2", children: /* @__PURE__ */ y(
        B,
        {
          variant: "outline",
          size: "sm",
          className: "w-full",
          onClick: o,
          children: [
            /* @__PURE__ */ a(at, { className: "mr-2 h-4 w-4" }),
            "Load surfaces"
          ]
        }
      ) })
    ] }),
    /* @__PURE__ */ a(Ie, { className: "flex-1 min-h-0", children: v != null && b[v] ? /* @__PURE__ */ y("div", { className: "grid gap-4 p-4", children: [
      /* @__PURE__ */ a(
        te,
        {
          label: "Opacity",
          value: ((U = b[v]) == null ? void 0 : U.opacity) || 1,
          onValueChange: r,
          min: 0,
          max: 1,
          step: 0.01
        }
      ),
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Color" }),
        /* @__PURE__ */ y("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ a(
            "input",
            {
              type: "color",
              value: pn(
                ((F = b[v]) == null ? void 0 : F.rgba255) || [
                  255,
                  255,
                  0,
                  255
                ]
              ),
              onChange: (R) => s(R.target.value),
              className: "h-9 w-16 rounded-md border border-input cursor-pointer"
            }
          ),
          /* @__PURE__ */ a("span", { className: "text-sm text-muted-foreground", children: pn(
            ((C = b[v]) == null ? void 0 : C.rgba255) || [
              255,
              255,
              0,
              255
            ]
          ) })
        ] })
      ] }),
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Mesh Shader" }),
        /* @__PURE__ */ a(
          be,
          {
            value: ((x = b[v]) == null ? void 0 : x.shaderType) || "phong",
            onChange: (R) => i(R.target.value),
            children: (M = e.current) == null ? void 0 : M.meshShaders.map((R) => /* @__PURE__ */ a("option", { value: R, children: R }, R))
          }
        )
      ] }),
      /* @__PURE__ */ y("div", { className: "border-t pt-4", children: [
        /* @__PURE__ */ y("div", { className: "flex items-center justify-between mb-2", children: [
          /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Layers" }),
          /* @__PURE__ */ y(B, { variant: "outline", size: "sm", onClick: c, children: [
            /* @__PURE__ */ a(at, { className: "mr-2 h-3 w-3" }),
            "Add"
          ] })
        ] }),
        k.length > 0 ? /* @__PURE__ */ a("div", { className: "grid gap-1 mb-4", children: k.map((R, O) => /* @__PURE__ */ y(
          "div",
          {
            className: Y(
              "flex items-center gap-2 p-2 rounded-md cursor-pointer text-sm",
              g === O ? "bg-muted" : "hover:bg-muted/50"
            ),
            onClick: () => N(O),
            children: [
              /* @__PURE__ */ a("div", { className: "flex-1 w-0", children: /* @__PURE__ */ a("p", { className: "text-sm truncate", children: R.name || `Layer ${O + 1}` }) }),
              /* @__PURE__ */ a(
                B,
                {
                  variant: "ghost",
                  size: "sm",
                  className: "h-6 w-6 p-0 hover:bg-destructive hover:text-destructive-foreground",
                  onClick: (H) => {
                    H.stopPropagation(), u(O);
                  },
                  title: "Remove layer",
                  children: /* @__PURE__ */ a(xt, { className: "h-3 w-3" })
                }
              )
            ]
          },
          O
        )) }) : /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground mb-4", children: "No layers loaded" }),
        E && /* @__PURE__ */ y("div", { className: "grid gap-4 border-t pt-4", children: [
          /* @__PURE__ */ a(
            te,
            {
              label: "Contrast Min",
              value: E.calMin ?? 0,
              onValueChange: f,
              min: -10,
              max: 10,
              step: 0.01
            }
          ),
          /* @__PURE__ */ a(
            te,
            {
              label: "Contrast Max",
              value: E.calMax ?? 1,
              onValueChange: m,
              min: -10,
              max: 10,
              step: 0.01
            }
          ),
          /* @__PURE__ */ a(
            te,
            {
              label: "Opacity",
              value: E.opacity ?? 1,
              onValueChange: d,
              min: 0,
              max: 1,
              step: 0.01
            }
          ),
          /* @__PURE__ */ y("div", { className: "space-y-2", children: [
            /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Colormap" }),
            /* @__PURE__ */ a(
              be,
              {
                value: E.colormap || "warm",
                onChange: (R) => w(R.target.value),
                children: (V = e.current) == null ? void 0 : V.colormaps.map((R) => /* @__PURE__ */ a("option", { value: R, children: R }, R))
              }
            )
          ] }),
          /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
            /* @__PURE__ */ a(
              se,
              {
                id: "use-negative-cmap",
                checked: !!E.colormapNegative,
                onCheckedChange: (R) => S(R === !0)
              }
            ),
            /* @__PURE__ */ a(
              G,
              {
                htmlFor: "use-negative-cmap",
                className: "text-sm font-medium",
                children: "Use Negative Colormap"
              }
            )
          ] })
        ] })
      ] })
    ] }) : /* @__PURE__ */ a("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground" }) })
  ] });
}
function Ed({
  nvRef: e,
  onDrawModeChange: t,
  onDrawingColormapChange: n,
  onPenFillChange: o,
  onPenErasesChange: r,
  onPenValueChange: s,
  onDrawingOpacityChange: i,
  onMagicWand2dOnlyChange: l,
  onMagicWandMaxDistanceChange: c,
  onMagicWandThresholdChange: u,
  onDrawUndo: d,
  onSaveDrawing: f
}) {
  var b;
  const m = A((v) => v.drawingOptions), w = A((v) => v.setDrawingOptions), S = ((b = e.current) == null ? void 0 : b.drawingColormaps) ?? [];
  return /* @__PURE__ */ y("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ y("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ a("h2", { className: "text-lg font-semibold", children: "Drawing Tools" }),
      /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground", children: "Edit annotations" })
    ] }),
    /* @__PURE__ */ a(Ie, { className: "flex-1 min-h-0", children: /* @__PURE__ */ a("div", { className: "p-4 space-y-4", children: m.enabled ? /* @__PURE__ */ y(De, { children: [
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Filename" }),
        /* @__PURE__ */ a(
          Le,
          {
            type: "text",
            value: m.filename,
            onChange: (v) => w((h) => ({
              ...h,
              filename: v.target.value
            })),
            placeholder: "Enter filename..."
          }
        )
      ] }),
      /* @__PURE__ */ a(
        te,
        {
          label: "Drawing Opacity",
          value: m.opacity,
          onValueChange: i,
          min: 0,
          max: 1,
          step: 0.01
        }
      ),
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Drawing Colormap" }),
        /* @__PURE__ */ a(
          be,
          {
            value: m.colormap,
            onChange: n,
            children: S.map((v) => /* @__PURE__ */ a("option", { value: v, children: v }, v))
          }
        )
      ] }),
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Draw Mode" }),
        /* @__PURE__ */ y(
          be,
          {
            value: m.mode,
            onChange: (v) => t(v.target.value),
            children: [
              /* @__PURE__ */ a("option", { value: "none", children: "None" }),
              /* @__PURE__ */ a("option", { value: "pen", children: "Pen" }),
              /* @__PURE__ */ a("option", { value: "wand", children: "Magic Wand" })
            ]
          }
        )
      ] }),
      (m.mode === "pen" || m.mode === "wand") && /* @__PURE__ */ y(
        B,
        {
          variant: "outline",
          size: "sm",
          className: "w-full",
          onClick: d,
          children: [
            /* @__PURE__ */ a(yo, { className: "mr-2 h-4 w-4" }),
            "Undo"
          ]
        }
      ),
      (m.mode === "pen" || m.mode === "wand") && /* @__PURE__ */ y(De, { children: [
        m.mode === "pen" && /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
          /* @__PURE__ */ a(
            se,
            {
              id: "pen-fill",
              checked: m.penFill,
              onCheckedChange: o
            }
          ),
          /* @__PURE__ */ a(G, { htmlFor: "pen-fill", className: "text-sm font-medium", children: "Pen Fill" })
        ] }),
        m.mode === "pen" && /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
          /* @__PURE__ */ a(
            se,
            {
              id: "pen-erases",
              checked: m.penErases,
              onCheckedChange: r
            }
          ),
          /* @__PURE__ */ a(
            G,
            {
              htmlFor: "pen-erases",
              className: "text-sm font-medium",
              children: "Pen Erases"
            }
          )
        ] }),
        m.mode === "wand" && /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
          /* @__PURE__ */ a(
            se,
            {
              id: "magic-wand-2d-only",
              checked: m.magicWand2dOnly,
              onCheckedChange: l
            }
          ),
          /* @__PURE__ */ a(
            G,
            {
              htmlFor: "magic-wand-2d-only",
              className: "text-sm font-medium",
              children: "2D Only"
            }
          )
        ] }),
        m.mode === "wand" && /* @__PURE__ */ a(
          te,
          {
            label: "Max Distance (mm)",
            value: m.magicWandMaxDistanceMM,
            onValueChange: c,
            min: 2,
            max: 500,
            step: 1
          }
        ),
        m.mode === "wand" && /* @__PURE__ */ a(
          te,
          {
            label: "Threshold Percentage",
            value: m.magicWandThresholdPercent,
            onValueChange: u,
            min: 0,
            max: 1,
            step: 0.01
          }
        ),
        /* @__PURE__ */ a(
          te,
          {
            label: "Pen Value",
            value: m.penValue,
            onValueChange: s,
            min: 1,
            max: 255,
            step: 1,
            disabled: m.penErases
          }
        )
      ] }),
      /* @__PURE__ */ y(
        B,
        {
          variant: "outline",
          size: "sm",
          className: "w-full",
          onClick: f,
          children: [
            /* @__PURE__ */ a(wo, { className: "mr-2 h-4 w-4" }),
            "Save Drawing"
          ]
        }
      )
    ] }) : /* @__PURE__ */ y("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground", children: [
      /* @__PURE__ */ a(Zt, { className: "h-8 w-8 mb-2" }),
      /* @__PURE__ */ a("p", { children: "No drawing layer active" }),
      /* @__PURE__ */ a("p", { className: "text-xs", children: "Create a drawing layer to access drawing tools" })
    ] }) }) })
  ] });
}
const Dd = [
  "Fantastic",
  "Bold",
  "Brave",
  "Calm",
  "Clever",
  "Curious",
  "Dapper",
  "Eager",
  "Fierce",
  "Gentle",
  "Happy",
  "Jolly",
  "Kind",
  "Lively",
  "Merry",
  "Noble",
  "Playful",
  "Proud",
  "Quick",
  "Quiet",
  "Radiant",
  "Silly",
  "Spry",
  "Sunny",
  "Swift",
  "Tidy",
  "Tiny",
  "Vivid",
  "Witty",
  "Wise",
  "Zany",
  "Zesty",
  "Amber",
  "Cosmic",
  "Dusty",
  "Golden",
  "Misty",
  "Nimble",
  "Plucky",
  "Steady"
], Id = [
  "Pony",
  "Badger",
  "Beaver",
  "Bison",
  "Cheetah",
  "Dolphin",
  "Eagle",
  "Ferret",
  "Finch",
  "Fox",
  "Gecko",
  "Giraffe",
  "Hawk",
  "Hedgehog",
  "Heron",
  "Jaguar",
  "Koala",
  "Lemur",
  "Lynx",
  "Magpie",
  "Mongoose",
  "Narwhal",
  "Newt",
  "Octopus",
  "Osprey",
  "Otter",
  "Panda",
  "Penguin",
  "Pelican",
  "Puffin",
  "Raccoon",
  "Raven",
  "Rhino",
  "Salmon",
  "Seal",
  "Sloth",
  "Stoat",
  "Tapir",
  "Tiger",
  "Walrus"
];
function Bn(e) {
  return e[Math.floor(Math.random() * e.length)];
}
function $n() {
  return `${Bn(Dd)}${Bn(Id)}`;
}
function Rd({
  volumesCount: e,
  onNewSession: t,
  onLoadSession: n,
  onRunSegmentation: o,
  onExitAndSaveSession: r,
  onExitAndDeleteSession: s,
  onRefreshSessions: i,
  onDrawModeChange: l,
  onDrawingOpacityChange: c,
  onPenValueChange: u,
  onPenFillChange: d,
  onPenErasesChange: f,
  onMagicWand2dOnlyChange: m,
  onMagicWandMaxDistanceChange: w,
  onMagicWandThresholdChange: S,
  onDrawUndo: b
}) {
  const v = A((z) => z.aiSessions), h = A((z) => z.aiActiveSession), g = A((z) => z.drawingOptions), [N, k] = ce(() => $n()), [E, U] = ce(""), [F, C] = ce(null), [x, M] = ce(!1), [V, R] = ce([]), [O, H] = ce(""), [D, P] = ce(1), [W, T] = ce(!1), [re, ae] = ce(null), [de, ie] = ce(!1);
  oe(() => {
    i();
  }, [i]);
  const q = I(async () => {
    try {
      const z = await fetch(Me("model/list"));
      if (!z.ok) throw new Error(`GET /ai/model/list failed: ${z.status}`);
      const pe = await z.json();
      R(pe), H(
        (nt) => {
          var dt;
          return nt && pe.some((Vt) => Vt.ml_id === nt) ? nt : ((dt = pe[0]) == null ? void 0 : dt.ml_id) ?? "";
        }
      );
    } catch (z) {
      console.error(z);
    }
  }, []);
  oe(() => {
    q();
  }, [q]);
  const Z = ga(() => {
    const z = {};
    for (const pe of v) z[pe.session_id] = pe;
    return z;
  }, [v]), me = async () => {
    C(null), M(!0);
    try {
      await t(N);
    } catch (z) {
      C(z instanceof Error ? z.message : String(z)), k($n());
    } finally {
      M(!1);
    }
  }, ye = async () => {
    if (E) {
      M(!0);
      try {
        await n(E);
      } catch (z) {
        console.error("Load Session failed:", z), C(z instanceof Error ? z.message : String(z));
      } finally {
        M(!1);
      }
    }
  }, J = () => {
    q();
  }, Fe = async () => {
    if (!(!h || !O)) {
      ae(null), T(!0);
      try {
        await o(O, D);
      } catch (z) {
        ae(z instanceof Error ? z.message : String(z));
      } finally {
        T(!1);
      }
    }
  }, xe = async () => {
    ae(null), ie(!0);
    try {
      await r();
    } catch (z) {
      ae(z instanceof Error ? z.message : String(z));
    } finally {
      ie(!1);
    }
  }, Ce = async () => {
    ae(null), ie(!0);
    try {
      await s();
    } catch (z) {
      ae(z instanceof Error ? z.message : String(z));
    } finally {
      ie(!1);
    }
  }, Se = (z) => {
    u(z === "positive" ? 1 : 2), g.mode !== "pen" && l("pen");
  };
  return /* @__PURE__ */ y("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ y("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ a("h2", { className: "text-lg font-semibold", children: "AI annotation (experimental)" }),
      /* @__PURE__ */ a("p", { className: "text-sm text-muted-foreground", children: "Guide an AI model with positive and negative seed voxels." })
    ] }),
    /* @__PURE__ */ a(Ie, { className: "flex-1 min-h-0", children: h ? h ? /* @__PURE__ */ y("div", { className: "p-4 space-y-4", children: [
      /* @__PURE__ */ y("div", { className: "space-y-1", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Session" }),
        /* @__PURE__ */ y("p", { className: "text-sm", children: [
          h.session_name,
          " ",
          /* @__PURE__ */ y("span", { className: "text-xs text-muted-foreground", children: [
            "(",
            h.session_id.slice(0, 8),
            "…)"
          ] })
        ] })
      ] }),
      /* @__PURE__ */ y(
        B,
        {
          variant: "outline",
          size: "sm",
          className: "w-full",
          onClick: () => void xe(),
          disabled: W || de,
          children: [
            /* @__PURE__ */ a(Ui, { className: "mr-2 h-4 w-4" }),
            "Exit and Save Session"
          ]
        }
      ),
      /* @__PURE__ */ y(
        B,
        {
          variant: "destructive",
          size: "sm",
          className: "w-full",
          onClick: () => void Ce(),
          disabled: W || de,
          children: [
            /* @__PURE__ */ a(xt, { className: "mr-2 h-4 w-4" }),
            "Exit and Delete Session"
          ]
        }
      ),
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Select AI model" }),
        /* @__PURE__ */ a(
          be,
          {
            value: O,
            onChange: (z) => H(z.target.value),
            children: V.length === 0 ? /* @__PURE__ */ a("option", { value: "", children: "(no models available)" }) : V.map((z) => /* @__PURE__ */ a("option", { value: z.ml_id, children: z.name }, z.ml_id))
          }
        ),
        /* @__PURE__ */ a(B, { variant: "outline", className: "w-full", onClick: J, children: "Reload Models" })
      ] }),
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Draw Mode" }),
        /* @__PURE__ */ y(
          be,
          {
            value: g.mode,
            onChange: (z) => l(z.target.value),
            children: [
              /* @__PURE__ */ a("option", { value: "none", children: "None" }),
              /* @__PURE__ */ a("option", { value: "pen", children: "Pen" }),
              /* @__PURE__ */ a("option", { value: "wand", children: "Magic Wand" })
            ]
          }
        )
      ] }),
      /* @__PURE__ */ a(
        te,
        {
          label: "Drawing Opacity",
          value: g.opacity,
          onValueChange: c,
          min: 0,
          max: 1,
          step: 0.01
        }
      ),
      (g.mode === "pen" || g.mode === "wand") && /* @__PURE__ */ y(
        B,
        {
          variant: "outline",
          size: "sm",
          className: "w-full",
          onClick: b,
          children: [
            /* @__PURE__ */ a(yo, { className: "mr-2 h-4 w-4" }),
            "Undo"
          ]
        }
      ),
      g.mode === "pen" && /* @__PURE__ */ y(De, { children: [
        /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
          /* @__PURE__ */ a(
            se,
            {
              id: "ai-pen-fill",
              checked: g.penFill,
              onCheckedChange: d
            }
          ),
          /* @__PURE__ */ a(G, { htmlFor: "ai-pen-fill", className: "text-sm font-medium", children: "Pen Fill" })
        ] }),
        /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
          /* @__PURE__ */ a(
            se,
            {
              id: "ai-pen-erases",
              checked: g.penErases,
              onCheckedChange: f
            }
          ),
          /* @__PURE__ */ a(G, { htmlFor: "ai-pen-erases", className: "text-sm font-medium", children: "Pen Erases" })
        ] })
      ] }),
      g.mode === "wand" && /* @__PURE__ */ y(De, { children: [
        /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
          /* @__PURE__ */ a(
            se,
            {
              id: "ai-magic-wand-2d-only",
              checked: g.magicWand2dOnly,
              onCheckedChange: m
            }
          ),
          /* @__PURE__ */ a(
            G,
            {
              htmlFor: "ai-magic-wand-2d-only",
              className: "text-sm font-medium",
              children: "2D Only"
            }
          )
        ] }),
        /* @__PURE__ */ a(
          te,
          {
            label: "Max Distance (mm)",
            value: g.magicWandMaxDistanceMM,
            onValueChange: w,
            min: 2,
            max: 500,
            step: 1
          }
        ),
        /* @__PURE__ */ a(
          te,
          {
            label: "Threshold Percentage",
            value: g.magicWandThresholdPercent,
            onValueChange: S,
            min: 0,
            max: 1,
            step: 0.01
          }
        )
      ] }),
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Click Mode" }),
        /* @__PURE__ */ y("div", { className: "flex gap-2", children: [
          /* @__PURE__ */ a(
            B,
            {
              variant: g.penValue === 1 ? "default" : "outline",
              size: "sm",
              className: "flex-1",
              onClick: () => Se("positive"),
              children: "+ Positive"
            }
          ),
          /* @__PURE__ */ a(
            B,
            {
              variant: g.penValue === 2 ? "default" : "outline",
              size: "sm",
              className: "flex-1",
              onClick: () => Se("negative"),
              children: "− Negative"
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ a(
        te,
        {
          label: "Result label value",
          value: D,
          onValueChange: P,
          min: 0,
          max: 255,
          step: 1,
          decimalPlaces: 0
        }
      ),
      /* @__PURE__ */ a("p", { className: "text-xs text-muted-foreground -mt-2", children: "Foreground voxel value in the returned mask." }),
      /* @__PURE__ */ y(
        B,
        {
          className: "w-full",
          onClick: () => void Fe(),
          disabled: !O || W || de,
          children: [
            /* @__PURE__ */ a(At, { className: "mr-2 h-4 w-4" }),
            W ? "Running segmentation…" : "Run Segmentation"
          ]
        }
      ),
      re && /* @__PURE__ */ a("p", { className: "text-xs text-destructive", children: re })
    ] }) : null : /* @__PURE__ */ y("div", { className: "p-4 space-y-6", children: [
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Session Name" }),
        /* @__PURE__ */ a(
          Le,
          {
            type: "text",
            value: N,
            onChange: (z) => k(z.target.value),
            placeholder: "Enter session name..."
          }
        ),
        /* @__PURE__ */ a(
          B,
          {
            className: "w-full",
            onClick: me,
            disabled: e === 0 || x,
            children: "New Session"
          }
        ),
        e === 0 && /* @__PURE__ */ a("p", { className: "text-xs text-muted-foreground", children: "Load a volume before creating a session." }),
        F && /* @__PURE__ */ a("p", { className: "text-xs text-destructive", children: F })
      ] }),
      /* @__PURE__ */ y("div", { className: "space-y-2", children: [
        /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Previous Sessions" }),
        /* @__PURE__ */ y(
          be,
          {
            value: E,
            onChange: (z) => U(z.target.value),
            disabled: v.length === 0 || x,
            children: [
              /* @__PURE__ */ a("option", { value: "", children: v.length === 0 ? "(no sessions)" : "Select a session..." }),
              v.map((z) => /* @__PURE__ */ a("option", { value: z.session_id, children: z.session_name }, z.session_id))
            ]
          }
        ),
        /* @__PURE__ */ a(
          B,
          {
            variant: "outline",
            className: "w-full",
            onClick: ye,
            disabled: !E || x,
            children: "Load Session"
          }
        ),
        E && Z[E] && /* @__PURE__ */ y("p", { className: "text-xs text-muted-foreground", children: [
          "volume: ",
          Z[E].volume_path ?? "—",
          /* @__PURE__ */ a("br", {}),
          "annotations:",
          " ",
          Z[E].annotation_path ?? "—"
        ] })
      ] })
    ] }) })
  ] });
}
function Pd(e) {
  const t = A((i) => i.activeTab), n = A((i) => i.setActiveTab), o = A((i) => i.drawingOptions), r = A((i) => i.aiEnabled), s = !e.serverlessMode && r === !0;
  return /* @__PURE__ */ a(
    "aside",
    {
      className: Y(
        "border-l bg-background w-80 overflow-hidden flex flex-col"
      ),
      children: /* @__PURE__ */ y(
        Tc,
        {
          value: t,
          onValueChange: n,
          className: "flex flex-col flex-1 min-h-0",
          children: [
            /* @__PURE__ */ y(Vc, { className: "w-full justify-start border-b rounded-none px-2 h-12 flex-shrink-0", children: [
              /* @__PURE__ */ a(
                We,
                {
                  value: "sceneDetails",
                  className: "data-[state=active]:bg-muted",
                  children: /* @__PURE__ */ a(bo, { className: "h-4 w-4 mr-2" })
                }
              ),
              /* @__PURE__ */ a(
                We,
                {
                  value: "surfaceDetails",
                  className: "data-[state=active]:bg-muted",
                  children: /* @__PURE__ */ a(At, { className: "h-4 w-4 mr-2" })
                }
              ),
              /* @__PURE__ */ a(
                We,
                {
                  value: "drawing",
                  className: Y(
                    "data-[state=active]:bg-muted",
                    !o.enabled && "text-muted-foreground"
                  ),
                  disabled: !o.enabled,
                  children: /* @__PURE__ */ a(Zt, { className: "h-4 w-4 mr-2" })
                }
              ),
              s && /* @__PURE__ */ a(
                We,
                {
                  value: "aiAnnotation",
                  className: "data-[state=active]:bg-muted",
                  children: /* @__PURE__ */ a(ll, { className: "h-4 w-4 mr-2" })
                }
              ),
              !e.serverlessMode && /* @__PURE__ */ a(We, { value: "nvds", className: "data-[state=active]:bg-muted", children: /* @__PURE__ */ a(Ri, { className: "h-4 w-4 mr-2" }) }),
              !e.serverlessMode && /* @__PURE__ */ a(We, { value: "data", className: "data-[state=active]:bg-muted", children: /* @__PURE__ */ a(Ni, { className: "h-4 w-4 mr-2" }) })
            ] }),
            /* @__PURE__ */ a(Be, { value: "sceneDetails", className: "flex-1 min-h-0 p-0", children: /* @__PURE__ */ a(
              Cd,
              {
                nvRef: e.nvRef,
                serverlessMode: e.serverlessMode,
                getVolumes: e.getVolumes,
                onToggleVisibility: e.onToggleImageVisibility,
                onEditVolume: e.onEditVolume,
                canEditVolume: e.canEditVolume,
                onRemoveVolume: e.onRemoveVolumeClick,
                onAddMoreFiles: e.onAddMoreFiles,
                onCreateDrawingLayer: e.onCreateDrawingLayer,
                onSaveScene: e.onSaveScene,
                onOpacityChange: e.onOpacityChange,
                onFrameChange: e.onFrameChange,
                onContrastMinChange: e.onContrastMinChange,
                onContrastMaxChange: e.onContrastMaxChange,
                onColormapChange: e.onColormapChange,
                onMoveVolumeUp: e.onMoveVolumeUp,
                onMoveVolumeDown: e.onMoveVolumeDown
              }
            ) }),
            /* @__PURE__ */ a(Be, { value: "surfaceDetails", className: "flex-1 min-h-0 p-0", children: /* @__PURE__ */ a(
              Md,
              {
                nvRef: e.nvRef,
                onToggleVisibility: e.onToggleSurfaceVisibility,
                onRemoveSurface: e.onRemoveSurfaceClick,
                onAddSurfaceFiles: e.onAddSurfaceFiles,
                onOpacityChange: e.onSurfaceOpacityChange,
                onColorChange: e.onSurfaceColorChange,
                onShaderChange: e.onMeshShaderChange,
                getLayers: e.getLayers,
                onAddLayerFiles: e.onAddLayerFiles,
                onRemoveLayer: e.onRemoveLayer,
                onLayerOpacityChange: e.onLayerOpacityChange,
                onLayerCalMinChange: e.onLayerCalMinChange,
                onLayerCalMaxChange: e.onLayerCalMaxChange,
                onLayerColormapChange: e.onLayerColormapChange,
                onLayerUseNegativeCmapChange: e.onLayerUseNegativeCmapChange
              }
            ) }),
            /* @__PURE__ */ a(Be, { value: "drawing", className: "flex-1 min-h-0 p-0", children: /* @__PURE__ */ a(
              Ed,
              {
                nvRef: e.nvRef,
                onDrawModeChange: e.onDrawModeChange,
                onDrawingColormapChange: e.onDrawingColormapChange,
                onPenFillChange: e.onPenFillChange,
                onPenErasesChange: e.onPenErasesChange,
                onPenValueChange: e.onPenValueChange,
                onDrawingOpacityChange: e.onDrawingOpacityChange,
                onMagicWand2dOnlyChange: e.onMagicWand2dOnlyChange,
                onMagicWandMaxDistanceChange: e.onMagicWandMaxDistanceChange,
                onMagicWandThresholdChange: e.onMagicWandThresholdChange,
                onDrawUndo: e.onDrawUndo,
                onSaveDrawing: e.onSaveDrawing
              }
            ) }),
            s && /* @__PURE__ */ a(Be, { value: "aiAnnotation", className: "flex-1 min-h-0 p-0", children: /* @__PURE__ */ a(
              Rd,
              {
                volumesCount: e.getVolumes().length,
                onNewSession: e.onAiNewSession,
                onLoadSession: e.onAiLoadSession,
                onRunSegmentation: e.onAiRunSegmentation,
                onExitAndSaveSession: e.onAiExitAndSaveSession,
                onExitAndDeleteSession: e.onAiExitAndDeleteSession,
                onRefreshSessions: e.onAiRefreshSessions,
                onDrawModeChange: e.onDrawModeChange,
                onDrawingOpacityChange: e.onDrawingOpacityChange,
                onPenValueChange: e.onPenValueChange,
                onPenFillChange: e.onPenFillChange,
                onPenErasesChange: e.onPenErasesChange,
                onMagicWand2dOnlyChange: e.onMagicWand2dOnlyChange,
                onMagicWandMaxDistanceChange: e.onMagicWandMaxDistanceChange,
                onMagicWandThresholdChange: e.onMagicWandThresholdChange,
                onDrawUndo: e.onDrawUndo
              }
            ) }),
            /* @__PURE__ */ a(Be, { value: "nvds", className: "flex-1 min-h-0 p-0", children: !e.serverlessMode && /* @__PURE__ */ a(qc, { onFileSelect: e.onNvdFileSelect }) }),
            /* @__PURE__ */ a(Be, { value: "data", className: "flex-1 min-h-0 p-0", children: !e.serverlessMode && /* @__PURE__ */ a(Jc, { onFileSelect: e.onImagingFileSelect }) })
          ]
        }
      )
    }
  );
}
const it = ({ open: e = !1, onOpenChange: t, children: n }) => (p.useEffect(() => {
  const o = (r) => {
    r.key === "Escape" && e && (t == null || t(!1));
  };
  return e && document.addEventListener("keydown", o), () => {
    document.removeEventListener("keydown", o);
  };
}, [e, t]), e ? /* @__PURE__ */ y("div", { className: "absolute inset-0 z-50 flex items-center justify-center", children: [
  /* @__PURE__ */ a(
    "div",
    {
      className: "absolute inset-0 bg-black/50",
      onClick: () => t == null ? void 0 : t(!1)
    }
  ),
  /* @__PURE__ */ a("div", { className: "relative", children: n })
] }) : null), Qe = p.forwardRef(({ className: e, children: t, onClose: n, ...o }, r) => /* @__PURE__ */ y(
  "div",
  {
    ref: r,
    className: Y(
      "relative bg-background border rounded-lg shadow-lg p-6 w-full max-w-lg mx-4",
      "animate-in fade-in-0 zoom-in-95",
      e
    ),
    ...o,
    children: [
      n && /* @__PURE__ */ a(
        "button",
        {
          onClick: n,
          className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
          children: /* @__PURE__ */ a(wl, { className: "h-4 w-4" })
        }
      ),
      t
    ]
  }
));
Qe.displayName = "DialogContent";
const lt = ({
  className: e,
  ...t
}) => /* @__PURE__ */ a(
  "div",
  {
    className: Y("flex flex-col space-y-1.5 text-center sm:text-left mb-4", e),
    ...t
  }
), et = p.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ a(
  "h2",
  {
    ref: n,
    className: Y("text-lg font-semibold leading-none tracking-tight", e),
    ...t
  }
));
et.displayName = "DialogTitle";
const tt = p.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ a(
  "p",
  {
    ref: n,
    className: Y("text-sm text-muted-foreground", e),
    ...t
  }
));
tt.displayName = "DialogDescription";
const ct = ({
  className: e,
  ...t
}) => /* @__PURE__ */ a(
  "div",
  {
    className: Y("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-6", e),
    ...t
  }
);
function Td({ onConfirm: e, onCancel: t }) {
  const n = A((l) => l.removeDialogOpen), o = A((l) => l.setRemoveDialogOpen), r = A((l) => l.skipRemoveConfirmation), s = A((l) => l.setSkipRemoveConfirmation), i = A((l) => l.surfaceToRemove);
  return /* @__PURE__ */ a(it, { open: n, onOpenChange: o, children: /* @__PURE__ */ y(Qe, { onClose: t, children: [
    /* @__PURE__ */ y(lt, { children: [
      /* @__PURE__ */ a(et, { children: i !== null ? "Remove Surface" : "Remove Volume" }),
      /* @__PURE__ */ y(tt, { children: [
        "Are you sure you want to remove this ",
        i !== null ? "surface" : "volume",
        "?"
      ] })
    ] }),
    /* @__PURE__ */ y("div", { className: "flex items-center space-x-2 mt-4", children: [
      /* @__PURE__ */ a(
        se,
        {
          id: "dont-ask-again",
          checked: r,
          onCheckedChange: (l) => s(l === !0)
        }
      ),
      /* @__PURE__ */ a(G, { htmlFor: "dont-ask-again", className: "text-sm", children: "Don't ask me again" })
    ] }),
    /* @__PURE__ */ y(ct, { children: [
      /* @__PURE__ */ a(B, { variant: "outline", onClick: t, children: "Cancel" }),
      /* @__PURE__ */ a(B, { variant: "destructive", onClick: e, children: "Remove" })
    ] })
  ] }) });
}
var mn = "Radio", [Vd, Vr] = we(mn), [Od, _d] = Vd(mn), Or = p.forwardRef(
  (e, t) => {
    const {
      __scopeRadio: n,
      name: o,
      checked: r = !1,
      required: s,
      disabled: i,
      value: l = "on",
      onCheck: c,
      form: u,
      ...d
    } = e, [f, m] = p.useState(null), w = ee(t, (v) => m(v)), S = p.useRef(!1), b = f ? u || !!f.closest("form") : !0;
    return /* @__PURE__ */ y(Od, { scope: n, checked: r, disabled: i, children: [
      /* @__PURE__ */ a(
        K.button,
        {
          type: "button",
          role: "radio",
          "aria-checked": r,
          "data-state": Ur(r),
          "data-disabled": i ? "" : void 0,
          disabled: i,
          value: l,
          ...d,
          ref: w,
          onClick: X(e.onClick, (v) => {
            r || c == null || c(), b && (S.current = v.isPropagationStopped(), S.current || v.stopPropagation());
          })
        }
      ),
      b && /* @__PURE__ */ a(
        Fr,
        {
          control: f,
          bubbles: !S.current,
          name: o,
          value: l,
          checked: r,
          required: s,
          disabled: i,
          form: u,
          style: { transform: "translateX(-100%)" }
        }
      )
    ] });
  }
);
Or.displayName = mn;
var _r = "RadioIndicator", Lr = p.forwardRef(
  (e, t) => {
    const { __scopeRadio: n, forceMount: o, ...r } = e, s = _d(_r, n);
    return /* @__PURE__ */ a(Te, { present: o || s.checked, children: /* @__PURE__ */ a(
      K.span,
      {
        "data-state": Ur(s.checked),
        "data-disabled": s.disabled ? "" : void 0,
        ...r,
        ref: t
      }
    ) });
  }
);
Lr.displayName = _r;
var Ld = "RadioBubbleInput", Fr = p.forwardRef(
  ({
    __scopeRadio: e,
    control: t,
    checked: n,
    bubbles: o = !0,
    ...r
  }, s) => {
    const i = p.useRef(null), l = ee(i, s), c = ln(n), u = cn(t);
    return p.useEffect(() => {
      const d = i.current;
      if (!d) return;
      const f = window.HTMLInputElement.prototype, w = Object.getOwnPropertyDescriptor(
        f,
        "checked"
      ).set;
      if (c !== n && w) {
        const S = new Event("click", { bubbles: o });
        w.call(d, n), d.dispatchEvent(S);
      }
    }, [c, n, o]), /* @__PURE__ */ a(
      K.input,
      {
        type: "radio",
        "aria-hidden": !0,
        defaultChecked: n,
        ...r,
        tabIndex: -1,
        ref: l,
        style: {
          ...r.style,
          ...u,
          position: "absolute",
          pointerEvents: "none",
          opacity: 0,
          margin: 0
        }
      }
    );
  }
);
Fr.displayName = Ld;
function Ur(e) {
  return e ? "checked" : "unchecked";
}
var Fd = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], Tt = "RadioGroup", [Ud] = we(Tt, [
  Je,
  Vr
]), zr = Je(), Wr = Vr(), [zd, Wd] = Ud(Tt), Br = p.forwardRef(
  (e, t) => {
    const {
      __scopeRadioGroup: n,
      name: o,
      defaultValue: r,
      value: s,
      required: i = !1,
      disabled: l = !1,
      orientation: c,
      dir: u,
      loop: d = !0,
      onValueChange: f,
      ...m
    } = e, w = zr(n), S = qe(u), [b, v] = Re({
      prop: s,
      defaultProp: r ?? null,
      onChange: f,
      caller: Tt
    });
    return /* @__PURE__ */ a(
      zd,
      {
        scope: n,
        name: o,
        required: i,
        disabled: l,
        value: b,
        onValueChange: v,
        children: /* @__PURE__ */ a(
          Qt,
          {
            asChild: !0,
            ...w,
            orientation: c,
            dir: S,
            loop: d,
            children: /* @__PURE__ */ a(
              K.div,
              {
                role: "radiogroup",
                "aria-required": i,
                "aria-orientation": c,
                "data-disabled": l ? "" : void 0,
                dir: S,
                ...m,
                ref: t
              }
            )
          }
        )
      }
    );
  }
);
Br.displayName = Tt;
var $r = "RadioGroupItem", Gr = p.forwardRef(
  (e, t) => {
    const { __scopeRadioGroup: n, disabled: o, ...r } = e, s = Wd($r, n), i = s.disabled || o, l = zr(n), c = Wr(n), u = p.useRef(null), d = ee(t, u), f = s.value === r.value, m = p.useRef(!1);
    return p.useEffect(() => {
      const w = (b) => {
        Fd.includes(b.key) && (m.current = !0);
      }, S = () => m.current = !1;
      return document.addEventListener("keydown", w), document.addEventListener("keyup", S), () => {
        document.removeEventListener("keydown", w), document.removeEventListener("keyup", S);
      };
    }, []), /* @__PURE__ */ a(
      en,
      {
        asChild: !0,
        ...l,
        focusable: !i,
        active: f,
        children: /* @__PURE__ */ a(
          Or,
          {
            disabled: i,
            required: s.required,
            checked: f,
            ...c,
            ...r,
            name: s.name,
            ref: d,
            onCheck: () => s.onValueChange(r.value),
            onKeyDown: X((w) => {
              w.key === "Enter" && w.preventDefault();
            }),
            onFocus: X(r.onFocus, () => {
              var w;
              m.current && ((w = u.current) == null || w.click());
            })
          }
        )
      }
    );
  }
);
Gr.displayName = $r;
var Bd = "RadioGroupIndicator", jr = p.forwardRef(
  (e, t) => {
    const { __scopeRadioGroup: n, ...o } = e, r = Wr(n);
    return /* @__PURE__ */ a(Lr, { ...r, ...o, ref: t });
  }
);
jr.displayName = Bd;
var $d = Br, Gd = Gr, jd = jr;
function Hd({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ a(
    $d,
    {
      "data-slot": "radio-group",
      className: Y("grid gap-3", e),
      ...t
    }
  );
}
function Gn({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ a(
    Gd,
    {
      "data-slot": "radio-group-item",
      className: Y(
        "border-input text-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 aspect-square size-4 shrink-0 rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ...t,
      children: /* @__PURE__ */ a(
        jd,
        {
          "data-slot": "radio-group-indicator",
          className: "relative flex items-center justify-center",
          children: /* @__PURE__ */ a(wi, { className: "fill-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" })
        }
      )
    }
  );
}
function Yd({
  nvRef: e,
  onConfirm: t,
  onCancel: n,
  onVolumeUrlChange: o,
  onVolumeCheckboxChange: r,
  onDocumentLocationChange: s,
  onDocumentCheckboxChange: i,
  onDocumentFormatChange: l
}) {
  const c = A((f) => f.saveDialogOpen), u = A((f) => f.setSaveDialogOpen), d = A((f) => f.saveState);
  return /* @__PURE__ */ a(it, { open: c, onOpenChange: u, children: /* @__PURE__ */ y(Qe, { onClose: n, children: [
    /* @__PURE__ */ y(lt, { children: [
      /* @__PURE__ */ a(et, { children: d.isDownloadMode ? "Download Scene" : "Save Scene" }),
      /* @__PURE__ */ a(tt, { children: d.isDownloadMode ? "Select the files you want to download." : "Enter the location where you want to save the scene." })
    ] }),
    /* @__PURE__ */ a("div", { className: "mt-4", children: /* @__PURE__ */ y("div", { className: "flex items-center gap-3 p-3 border rounded-md", children: [
      /* @__PURE__ */ a(
        se,
        {
          id: "document-checkbox",
          checked: d.document.enabled,
          onCheckedChange: i,
          disabled: !d.document.location.trim()
        }
      ),
      /* @__PURE__ */ y("div", { className: "flex-1 min-w-0", children: [
        /* @__PURE__ */ a(
          G,
          {
            htmlFor: "document-checkbox",
            className: "text-sm font-medium",
            children: d.isDownloadMode ? "NiiVue Document Name" : "NiiVue Document Save Location"
          }
        ),
        /* @__PURE__ */ a(
          Le,
          {
            id: "save-location",
            type: "text",
            placeholder: d.isDownloadMode ? "Enter filename..." : "Enter file path...",
            value: d.document.location,
            onChange: (f) => s(f.target.value),
            className: "mt-1"
          }
        ),
        /* @__PURE__ */ y("div", { className: "mt-3", children: [
          /* @__PURE__ */ a(G, { className: "text-xs font-medium text-muted-foreground", children: "Format" }),
          /* @__PURE__ */ y(
            Hd,
            {
              value: d.document.format,
              onValueChange: (f) => l(f),
              className: "mt-1 flex gap-4",
              children: [
                /* @__PURE__ */ y("div", { className: "flex items-center gap-2", children: [
                  /* @__PURE__ */ a(Gn, { value: "json", id: "format-json" }),
                  /* @__PURE__ */ a(G, { htmlFor: "format-json", className: "text-sm font-normal", children: "JSON" })
                ] }),
                /* @__PURE__ */ y("div", { className: "flex items-center gap-2", children: [
                  /* @__PURE__ */ a(
                    Gn,
                    {
                      value: "cbor",
                      id: "format-cbor",
                      disabled: !d.isDownloadMode
                    }
                  ),
                  /* @__PURE__ */ a(
                    G,
                    {
                      htmlFor: "format-cbor",
                      className: "text-sm font-normal data-[disabled]:text-muted-foreground",
                      "data-disabled": !d.isDownloadMode || void 0,
                      children: "CBOR"
                    }
                  )
                ] })
              ]
            }
          ),
          !d.isDownloadMode && /* @__PURE__ */ a("p", { className: "mt-1 text-xs text-muted-foreground", children: "CBOR is download-only: saving to the server rewrites each volume’s URL to its upload destination, which needs the text format." })
        ] })
      ] })
    ] }) }),
    d.volumes.length > 0 && /* @__PURE__ */ y("div", { className: "mt-4", children: [
      /* @__PURE__ */ y(G, { className: "text-sm font-medium", children: [
        "Volumes to ",
        d.isDownloadMode ? "Download" : "Save"
      ] }),
      /* @__PURE__ */ a("div", { className: "mt-2 space-y-4 max-h-48 overflow-y-auto", children: d.volumes.map((f, m) => {
        var S;
        const w = (S = e.current) == null ? void 0 : S.volumes[m];
        return !f || !w ? null : /* @__PURE__ */ y(
          "div",
          {
            className: "flex items-center gap-3 p-3 border rounded-md",
            children: [
              /* @__PURE__ */ a(
                se,
                {
                  id: `volume-${m}`,
                  checked: f.enabled,
                  onCheckedChange: (b) => r(m, b === !0)
                }
              ),
              /* @__PURE__ */ y("div", { className: "flex-1 min-w-0", children: [
                /* @__PURE__ */ a(
                  G,
                  {
                    htmlFor: `volume-${m}`,
                    className: "text-sm font-medium",
                    children: w.name || `Volume ${m + 1}`
                  }
                ),
                /* @__PURE__ */ a(
                  Le,
                  {
                    type: "text",
                    placeholder: d.isDownloadMode ? "Enter filename..." : "Enter path...",
                    value: f.url || "",
                    onChange: (b) => o(m, b.target.value),
                    className: "mt-1 text-xs"
                  }
                ),
                !d.isDownloadMode && f.isExternal && !f.enabled && /* @__PURE__ */ a("p", { className: "text-xs text-muted-foreground mt-1", children: "External URL - check to save with custom path" })
              ] })
            ]
          },
          m
        );
      }) })
    ] }),
    /* @__PURE__ */ y(ct, { children: [
      /* @__PURE__ */ a(B, { variant: "outline", onClick: n, children: "Cancel" }),
      /* @__PURE__ */ a(
        B,
        {
          onClick: t,
          disabled: !d.document.enabled && !d.volumes.some((f) => f.enabled),
          children: "OK"
        }
      )
    ] })
  ] }) });
}
function Xd({ nvRef: e }) {
  const t = A((g) => g.settingsDialogOpen), n = A(
    (g) => g.setSettingsDialogOpen
  ), o = A(
    (g) => g.skipRemoveConfirmation
  ), r = A(
    (g) => g.setSkipRemoveConfirmation
  ), s = A(
    (g) => g.skipImagingUploadConfirmation
  ), i = A(
    (g) => g.setSkipImagingUploadConfirmation
  ), l = A(
    (g) => g.skipSessionDeleteConfirmation
  ), c = A(
    (g) => g.setSkipSessionDeleteConfirmation
  ), {
    viewerOptions: u,
    handleCrosshairWidthChange: d,
    handleCrosshairGapChange: f,
    handleInterpolateVoxelsChange: m,
    handleCrosshairVisibleChange: w,
    handleCrosshairColorChange: S,
    handleOverlayOutlineWidthChange: b,
    handleColorbarChange: v,
    handleRadiologicalChange: h
  } = Xt(e);
  return /* @__PURE__ */ a(it, { open: t, onOpenChange: n, children: /* @__PURE__ */ y(
    Qe,
    {
      onClose: () => n(!1),
      className: "max-w-2xl",
      children: [
        /* @__PURE__ */ y(lt, { children: [
          /* @__PURE__ */ a(et, { children: "FreeBrowse Settings" }),
          /* @__PURE__ */ a(tt, { children: "Configure the FreeBrowse viewer settings" })
        ] }),
        /* @__PURE__ */ y("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6 py-4", children: [
          /* @__PURE__ */ y("div", { className: "space-y-6", children: [
            /* @__PURE__ */ a("h3", { className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: "Appearance" }),
            /* @__PURE__ */ y("div", { className: "space-y-4", children: [
              /* @__PURE__ */ y("div", { className: "flex items-center justify-between", children: [
                /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Crosshair Width" }),
                /* @__PURE__ */ a(
                  B,
                  {
                    variant: "ghost",
                    size: "sm",
                    className: "h-6 w-6 p-0",
                    onClick: () => w(
                      !u.crosshairVisible
                    ),
                    children: u.crosshairVisible ? /* @__PURE__ */ a(Jt, { className: "h-4 w-4" }) : /* @__PURE__ */ a(qt, { className: "h-4 w-4 opacity-50" })
                  }
                )
              ] }),
              /* @__PURE__ */ a(
                te,
                {
                  label: "",
                  value: u.crosshairWidth,
                  onValueChange: d,
                  min: 0,
                  max: 5,
                  step: 0.1,
                  decimalPlaces: 1,
                  disabled: !u.crosshairVisible
                }
              )
            ] }),
            /* @__PURE__ */ a("div", { className: "space-y-2", children: /* @__PURE__ */ a(
              te,
              {
                label: "Crosshair Gap",
                value: u.crosshairGap,
                onValueChange: f,
                min: 0,
                max: 10,
                step: 0.5,
                decimalPlaces: 1,
                disabled: !u.crosshairVisible
              }
            ) }),
            /* @__PURE__ */ y("div", { className: "space-y-2", children: [
              /* @__PURE__ */ a(G, { className: "text-sm font-medium", children: "Crosshair Color" }),
              /* @__PURE__ */ a(
                Le,
                {
                  type: "color",
                  value: `#${Math.round(u.crosshairColor[0] * 255).toString(16).padStart(2, "0")}${Math.round(
                    u.crosshairColor[1] * 255
                  ).toString(16).padStart(2, "0")}${Math.round(
                    u.crosshairColor[2] * 255
                  ).toString(16).padStart(2, "0")}`,
                  onChange: (g) => S(g.target.value),
                  className: "w-full h-10"
                }
              )
            ] }),
            /* @__PURE__ */ a("div", { className: "space-y-2", children: /* @__PURE__ */ a(
              te,
              {
                label: "Overlay Outline Width",
                value: u.overlayOutlineWidth,
                onValueChange: b,
                min: 0,
                max: 2,
                step: 0.1,
                decimalPlaces: 1
              }
            ) })
          ] }),
          /* @__PURE__ */ y("div", { className: "space-y-6", children: [
            /* @__PURE__ */ y("div", { className: "space-y-3", children: [
              /* @__PURE__ */ a("h3", { className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: "View Options" }),
              /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ a(
                  se,
                  {
                    id: "show-colorbar",
                    checked: u.isColorbar,
                    onCheckedChange: (g) => v(g)
                  }
                ),
                /* @__PURE__ */ a(G, { htmlFor: "show-colorbar", className: "text-sm font-medium", children: "Show Colorbar" })
              ] }),
              /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ a(
                  se,
                  {
                    id: "radiological-view",
                    checked: u.isRadiologicalConvention,
                    onCheckedChange: (g) => h(g)
                  }
                ),
                /* @__PURE__ */ a(
                  G,
                  {
                    htmlFor: "radiological-view",
                    className: "text-sm font-medium",
                    children: "Radiological View"
                  }
                )
              ] }),
              /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ a(
                  se,
                  {
                    id: "interpolate-voxels",
                    checked: u.interpolateVoxels,
                    onCheckedChange: (g) => m(g)
                  }
                ),
                /* @__PURE__ */ a(
                  G,
                  {
                    htmlFor: "interpolate-voxels",
                    className: "text-sm font-medium",
                    children: "Interpolate Voxels"
                  }
                )
              ] })
            ] }),
            /* @__PURE__ */ y("div", { className: "space-y-3", children: [
              /* @__PURE__ */ a("h3", { className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: "Confirmations" }),
              /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ a(
                  se,
                  {
                    id: "skip-remove-confirmation",
                    checked: o,
                    onCheckedChange: (g) => r(g)
                  }
                ),
                /* @__PURE__ */ a(
                  G,
                  {
                    htmlFor: "skip-remove-confirmation",
                    className: "text-sm font-medium",
                    children: "Don't ask me to confirm removals"
                  }
                )
              ] }),
              /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ a(
                  se,
                  {
                    id: "skip-imaging-upload-confirmation-settings",
                    checked: s,
                    onCheckedChange: (g) => i(g)
                  }
                ),
                /* @__PURE__ */ a(
                  G,
                  {
                    htmlFor: "skip-imaging-upload-confirmation-settings",
                    className: "text-sm font-medium",
                    children: "Don't ask me to confirm imaging data uploads"
                  }
                )
              ] }),
              /* @__PURE__ */ y("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ a(
                  se,
                  {
                    id: "skip-session-delete-confirmation-settings",
                    checked: l,
                    onCheckedChange: (g) => c(g)
                  }
                ),
                /* @__PURE__ */ a(
                  G,
                  {
                    htmlFor: "skip-session-delete-confirmation-settings",
                    className: "text-sm font-medium",
                    children: "Don't ask me to confirm session deletions"
                  }
                )
              ] })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ a(ct, { children: /* @__PURE__ */ a(B, { onClick: () => n(!1), children: "Close" }) })
      ]
    }
  ) });
}
function Kd({
  onConfirm: e,
  onCancel: t
}) {
  const n = A((i) => i.imagingUploadConfirmDialogOpen), o = A((i) => i.setImagingUploadConfirmDialogOpen), r = A((i) => i.skipImagingUploadConfirmation), s = A((i) => i.setSkipImagingUploadConfirmation);
  return /* @__PURE__ */ a(it, { open: n, onOpenChange: o, children: /* @__PURE__ */ y(Qe, { onClose: t, children: [
    /* @__PURE__ */ y(lt, { children: [
      /* @__PURE__ */ a(et, { children: "Upload imaging data to backend?" }),
      /* @__PURE__ */ a(tt, { children: "Warning: this operation will transfer imaging data to the backend server. Are you sure you want to proceed?" })
    ] }),
    /* @__PURE__ */ y("div", { className: "flex items-center space-x-2 mt-4", children: [
      /* @__PURE__ */ a(
        se,
        {
          id: "skip-imaging-upload-confirmation",
          checked: r,
          onCheckedChange: (i) => s(i === !0)
        }
      ),
      /* @__PURE__ */ a(
        G,
        {
          htmlFor: "skip-imaging-upload-confirmation",
          className: "text-sm",
          children: "Don't ask me again to confirm imaging data uploads"
        }
      )
    ] }),
    /* @__PURE__ */ y(ct, { children: [
      /* @__PURE__ */ a(B, { variant: "outline", onClick: t, children: "Cancel" }),
      /* @__PURE__ */ a(B, { onClick: e, children: "Upload" })
    ] })
  ] }) });
}
function qd({
  onConfirm: e,
  onCancel: t
}) {
  const n = A((i) => i.sessionDeleteConfirmDialogOpen), o = A((i) => i.setSessionDeleteConfirmDialogOpen), r = A((i) => i.skipSessionDeleteConfirmation), s = A((i) => i.setSkipSessionDeleteConfirmation);
  return /* @__PURE__ */ a(it, { open: n, onOpenChange: o, children: /* @__PURE__ */ y(Qe, { onClose: t, children: [
    /* @__PURE__ */ y(lt, { children: [
      /* @__PURE__ */ a(et, { children: "Delete this session?" }),
      /* @__PURE__ */ a(tt, { children: "Are you sure you want to delete this session? The session folder and its contents will be removed from the backend." })
    ] }),
    /* @__PURE__ */ y("div", { className: "flex items-center space-x-2 mt-4", children: [
      /* @__PURE__ */ a(
        se,
        {
          id: "skip-session-delete-confirmation",
          checked: r,
          onCheckedChange: (i) => s(i === !0)
        }
      ),
      /* @__PURE__ */ a(
        G,
        {
          htmlFor: "skip-session-delete-confirmation",
          className: "text-sm",
          children: "Don't ask me to confirm session deletions"
        }
      )
    ] }),
    /* @__PURE__ */ y(ct, { children: [
      /* @__PURE__ */ a(B, { variant: "outline", onClick: t, children: "Cancel" }),
      /* @__PURE__ */ a(B, { variant: "destructive", onClick: e, children: "Delete" })
    ] })
  ] }) });
}
function ou({
  nv: e,
  exposeGlobal: t,
  hostInstance: n = !1,
  dragDrop: o,
  sidebar: r,
  footer: s
}) {
  const i = t ?? je().exposeGlobal;
  oe(() => {
    const ke = {};
    o !== void 0 && (ke.dragDropEnabled = o, o || (ke.showUploader = !1)), r !== void 0 && (ke.sidebarOpen = r), s !== void 0 && (ke.footerOpen = s), Object.keys(ke).length && A.setState(ke);
  }, [o, r, s]);
  const l = le(e);
  l.current = e, oe(() => {
    const ke = ya(e, Ga(e));
    return i && (window.freebrowse = { nv: e }), () => {
      var hn;
      ke(), ((hn = window.freebrowse) == null ? void 0 : hn.nv) === e && delete window.freebrowse;
    };
  }, [e, i]);
  const {
    viewerOptions: c,
    applyViewerOptions: u,
    syncViewerOptionsFromNiiVue: d,
    debouncedGLUpdate: f
  } = Xt(l, n ? "sync" : "apply"), {
    updateSurfaceDetails: m,
    toggleSurfaceVisibility: w,
    removeSurface: S,
    handleRemoveSurfaceClick: b,
    handleSurfaceOpacityChange: v,
    handleSurfaceColorChange: h,
    handleMeshShaderChange: g
  } = Ya(l), {
    layerFileInputRef: N,
    getLayers: k,
    removeLayer: E,
    handleLayerOpacityChange: U,
    handleLayerCalMinChange: F,
    handleLayerCalMaxChange: C,
    handleLayerColormapChange: x,
    handleLayerUseNegativeCmapChange: M,
    handleAddLayerFiles: V,
    handleLayerFileChange: R
  } = Xa(l), {
    getVolumes: O,
    toggleImageVisibility: H,
    handleOpacityChange: D,
    handleFrameChange: P,
    handleContrastMinChange: W,
    handleContrastMaxChange: T,
    handleColormapChange: re,
    handleMoveVolumeUp: ae,
    handleMoveVolumeDown: de,
    handleRemoveVolumeClick: ie,
    handleEditVolume: q,
    canEditVolume: Z,
    handleConfirmRemove: me,
    handleCancelRemove: ye
  } = Ha(l, f, S), {
    handleCreateDrawingLayer: J,
    handleDrawingColormapChange: Fe,
    handleDrawModeChange: xe,
    handlePenFillChange: Ce,
    handlePenErasesChange: Se,
    handlePenValueChange: Ve,
    handleDrawingOpacityChange: fn,
    handleMagicWand2dOnlyChange: z,
    handleMagicWandMaxDistanceChange: pe,
    handleMagicWandThresholdChange: nt,
    handleDrawUndo: dt,
    handleSaveDrawing: Vt
  } = Ka(l);
  es(l);
  const {
    handleSaveScene: Hr,
    handleConfirmSave: Yr,
    handleCancelSave: Xr,
    handleVolumeUrlChange: Kr,
    handleVolumeCheckboxChange: qr,
    handleDocumentLocationChange: Jr,
    handleDocumentCheckboxChange: Zr,
    handleDocumentFormatChange: Qr
  } = rs(l), {
    serverlessMode: ea,
    fileInputRef: ta,
    surfaceFileInputRef: na,
    handleFileUpload: oa,
    handleImagingFileSelect: ra,
    handleNvdFileSelect: aa,
    handleFileChange: sa,
    handleAddMoreFiles: ia,
    handleAddSurfaceFiles: la,
    handleSurfaceFileChange: ca
  } = as(
    l,
    u,
    d,
    m
  );
  ss();
  const {
    refreshSessions: da,
    handleNewSession: ua,
    handleLoadSession: ma,
    handleRunSegmentation: fa,
    handleExitAndSaveSession: ha,
    handleExitAndDeleteSession: pa
  } = hs(l);
  return /* @__PURE__ */ a(
    Sc,
    {
      nvInstance: e,
      viewMode: c.viewMode,
      onFileUpload: oa,
      sidebar: /* @__PURE__ */ a(
        Pd,
        {
          nvRef: l,
          serverlessMode: ea,
          onNvdFileSelect: aa,
          onImagingFileSelect: ra,
          onAddMoreFiles: ia,
          onAddSurfaceFiles: la,
          getVolumes: O,
          onToggleImageVisibility: H,
          onEditVolume: q,
          canEditVolume: Z,
          onRemoveVolumeClick: ie,
          onOpacityChange: D,
          onFrameChange: P,
          onContrastMinChange: W,
          onContrastMaxChange: T,
          onColormapChange: re,
          onMoveVolumeUp: ae,
          onMoveVolumeDown: de,
          onToggleSurfaceVisibility: w,
          onRemoveSurfaceClick: b,
          onSurfaceOpacityChange: v,
          onSurfaceColorChange: h,
          onMeshShaderChange: g,
          getLayers: k,
          onAddLayerFiles: V,
          onRemoveLayer: E,
          onLayerOpacityChange: U,
          onLayerCalMinChange: F,
          onLayerCalMaxChange: C,
          onLayerColormapChange: x,
          onLayerUseNegativeCmapChange: M,
          onCreateDrawingLayer: J,
          onDrawModeChange: xe,
          onDrawingColormapChange: Fe,
          onPenFillChange: Ce,
          onPenErasesChange: Se,
          onPenValueChange: Ve,
          onDrawingOpacityChange: fn,
          onMagicWand2dOnlyChange: z,
          onMagicWandMaxDistanceChange: pe,
          onMagicWandThresholdChange: nt,
          onDrawUndo: dt,
          onSaveDrawing: Vt,
          onSaveScene: Hr,
          onAiNewSession: ua,
          onAiLoadSession: ma,
          onAiRunSegmentation: fa,
          onAiExitAndSaveSession: ha,
          onAiExitAndDeleteSession: pa,
          onAiRefreshSessions: da
        }
      ),
      dialogs: /* @__PURE__ */ y(De, { children: [
        /* @__PURE__ */ a(
          Td,
          {
            onConfirm: me,
            onCancel: ye
          }
        ),
        /* @__PURE__ */ a(
          Yd,
          {
            nvRef: l,
            onConfirm: Yr,
            onCancel: Xr,
            onVolumeUrlChange: Kr,
            onVolumeCheckboxChange: qr,
            onDocumentLocationChange: Jr,
            onDocumentCheckboxChange: Zr,
            onDocumentFormatChange: Qr
          }
        ),
        /* @__PURE__ */ a(Xd, { nvRef: l }),
        /* @__PURE__ */ a(
          Kd,
          {
            onConfirm: () => bn(!0),
            onCancel: () => bn(!1)
          }
        ),
        /* @__PURE__ */ a(
          qd,
          {
            onConfirm: () => wn(!0),
            onCancel: () => wn(!1)
          }
        )
      ] }),
      hiddenInputs: /* @__PURE__ */ y(De, { children: [
        /* @__PURE__ */ a(
          "input",
          {
            type: "file",
            ref: ta,
            onChange: sa,
            multiple: !0,
            className: "hidden"
          }
        ),
        /* @__PURE__ */ a(
          "input",
          {
            type: "file",
            ref: na,
            onChange: ca,
            multiple: !0,
            className: "hidden"
          }
        ),
        /* @__PURE__ */ a(
          "input",
          {
            type: "file",
            ref: N,
            onChange: R,
            multiple: !0,
            className: "hidden"
          }
        )
      ] })
    }
  );
}
export {
  os as DEFAULT_NIIVUE_OPTIONS,
  ou as FreeBrowse,
  tu as configureFreeBrowse,
  nu as createFreeBrowseInstance,
  je as getFreeBrowseConfig
};
