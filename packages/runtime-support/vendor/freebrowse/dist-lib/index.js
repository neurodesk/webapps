import { SHOW_RENDER as va, DRAG_MODE as fo, NVWorker as gy, NiiVue as vy } from "@niivue/niivue";
function py(e, t) {
  for (var n = 0; n < t.length; n++) {
    const a = t[n];
    if (typeof a != "string" && !Array.isArray(a)) {
      for (const l in a)
        if (l !== "default" && !(l in e)) {
          const i = Object.getOwnPropertyDescriptor(a, l);
          i && Object.defineProperty(e, l, i.get ? i : {
            enumerable: !0,
            get: () => a[l]
          });
        }
    }
  }
  return Object.freeze(Object.defineProperty(e, Symbol.toStringTag, { value: "Module" }));
}
function yy(e) {
  return e && e.__esModule && Object.prototype.hasOwnProperty.call(e, "default") ? e.default : e;
}
var Xd = { exports: {} }, $o = {};
/**
 * @license React
 * react-jsx-runtime.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var by = Symbol.for("react.transitional.element"), xy = Symbol.for("react.fragment");
function Qd(e, t, n) {
  var a = null;
  if (n !== void 0 && (a = "" + n), t.key !== void 0 && (a = "" + t.key), "key" in t) {
    n = {};
    for (var l in t)
      l !== "key" && (n[l] = t[l]);
  } else n = t;
  return t = n.ref, {
    $$typeof: by,
    type: e,
    key: a,
    ref: t !== void 0 ? t : null,
    props: n
  };
}
$o.Fragment = xy;
$o.jsx = Qd;
$o.jsxs = Qd;
Xd.exports = $o;
var r = Xd.exports, Zd = { exports: {} }, Po = {}, Fd = { exports: {} }, Kd = {};
/**
 * @license React
 * scheduler.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
(function(e) {
  function t(j, U) {
    var D = j.length;
    j.push(U);
    e: for (; 0 < D; ) {
      var Q = D - 1 >>> 1, I = j[Q];
      if (0 < l(I, U))
        j[Q] = U, j[D] = I, D = Q;
      else break e;
    }
  }
  function n(j) {
    return j.length === 0 ? null : j[0];
  }
  function a(j) {
    if (j.length === 0) return null;
    var U = j[0], D = j.pop();
    if (D !== U) {
      j[0] = D;
      e: for (var Q = 0, I = j.length, Be = I >>> 1; Q < Be; ) {
        var we = 2 * (Q + 1) - 1, ie = j[we], ne = we + 1, Qe = j[ne];
        if (0 > l(ie, D))
          ne < I && 0 > l(Qe, ie) ? (j[Q] = Qe, j[ne] = D, Q = ne) : (j[Q] = ie, j[we] = D, Q = we);
        else if (ne < I && 0 > l(Qe, D))
          j[Q] = Qe, j[ne] = D, Q = ne;
        else break e;
      }
    }
    return U;
  }
  function l(j, U) {
    var D = j.sortIndex - U.sortIndex;
    return D !== 0 ? D : j.id - U.id;
  }
  if (e.unstable_now = void 0, typeof performance == "object" && typeof performance.now == "function") {
    var i = performance;
    e.unstable_now = function() {
      return i.now();
    };
  } else {
    var o = Date, s = o.now();
    e.unstable_now = function() {
      return o.now() - s;
    };
  }
  var c = [], u = [], m = 1, g = null, f = 3, p = !1, C = !1, x = !1, S = !1, h = typeof setTimeout == "function" ? setTimeout : null, d = typeof clearTimeout == "function" ? clearTimeout : null, y = typeof setImmediate < "u" ? setImmediate : null;
  function b(j) {
    for (var U = n(u); U !== null; ) {
      if (U.callback === null) a(u);
      else if (U.startTime <= j)
        a(u), U.sortIndex = U.expirationTime, t(c, U);
      else break;
      U = n(u);
    }
  }
  function N(j) {
    if (x = !1, b(j), !C)
      if (n(c) !== null)
        C = !0, O || (O = !0, k());
      else {
        var U = n(u);
        U !== null && z(N, U.startTime - j);
      }
  }
  var O = !1, M = -1, A = 5, w = -1;
  function E() {
    return S ? !0 : !(e.unstable_now() - w < A);
  }
  function R() {
    if (S = !1, O) {
      var j = e.unstable_now();
      w = j;
      var U = !0;
      try {
        e: {
          C = !1, x && (x = !1, d(M), M = -1), p = !0;
          var D = f;
          try {
            t: {
              for (b(j), g = n(c); g !== null && !(g.expirationTime > j && E()); ) {
                var Q = g.callback;
                if (typeof Q == "function") {
                  g.callback = null, f = g.priorityLevel;
                  var I = Q(
                    g.expirationTime <= j
                  );
                  if (j = e.unstable_now(), typeof I == "function") {
                    g.callback = I, b(j), U = !0;
                    break t;
                  }
                  g === n(c) && a(c), b(j);
                } else a(c);
                g = n(c);
              }
              if (g !== null) U = !0;
              else {
                var Be = n(u);
                Be !== null && z(
                  N,
                  Be.startTime - j
                ), U = !1;
              }
            }
            break e;
          } finally {
            g = null, f = D, p = !1;
          }
          U = void 0;
        }
      } finally {
        U ? k() : O = !1;
      }
    }
  }
  var k;
  if (typeof y == "function")
    k = function() {
      y(R);
    };
  else if (typeof MessageChannel < "u") {
    var V = new MessageChannel(), J = V.port2;
    V.port1.onmessage = R, k = function() {
      J.postMessage(null);
    };
  } else
    k = function() {
      h(R, 0);
    };
  function z(j, U) {
    M = h(function() {
      j(e.unstable_now());
    }, U);
  }
  e.unstable_IdlePriority = 5, e.unstable_ImmediatePriority = 1, e.unstable_LowPriority = 4, e.unstable_NormalPriority = 3, e.unstable_Profiling = null, e.unstable_UserBlockingPriority = 2, e.unstable_cancelCallback = function(j) {
    j.callback = null;
  }, e.unstable_forceFrameRate = function(j) {
    0 > j || 125 < j ? console.error(
      "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"
    ) : A = 0 < j ? Math.floor(1e3 / j) : 5;
  }, e.unstable_getCurrentPriorityLevel = function() {
    return f;
  }, e.unstable_next = function(j) {
    switch (f) {
      case 1:
      case 2:
      case 3:
        var U = 3;
        break;
      default:
        U = f;
    }
    var D = f;
    f = U;
    try {
      return j();
    } finally {
      f = D;
    }
  }, e.unstable_requestPaint = function() {
    S = !0;
  }, e.unstable_runWithPriority = function(j, U) {
    switch (j) {
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
        break;
      default:
        j = 3;
    }
    var D = f;
    f = j;
    try {
      return U();
    } finally {
      f = D;
    }
  }, e.unstable_scheduleCallback = function(j, U, D) {
    var Q = e.unstable_now();
    switch (typeof D == "object" && D !== null ? (D = D.delay, D = typeof D == "number" && 0 < D ? Q + D : Q) : D = Q, j) {
      case 1:
        var I = -1;
        break;
      case 2:
        I = 250;
        break;
      case 5:
        I = 1073741823;
        break;
      case 4:
        I = 1e4;
        break;
      default:
        I = 5e3;
    }
    return I = D + I, j = {
      id: m++,
      callback: U,
      priorityLevel: j,
      startTime: D,
      expirationTime: I,
      sortIndex: -1
    }, D > Q ? (j.sortIndex = D, t(u, j), n(c) === null && j === n(u) && (x ? (d(M), M = -1) : x = !0, z(N, D - Q))) : (j.sortIndex = I, t(c, j), C || p || (C = !0, O || (O = !0, k()))), j;
  }, e.unstable_shouldYield = E, e.unstable_wrapCallback = function(j) {
    var U = f;
    return function() {
      var D = f;
      f = U;
      try {
        return j.apply(this, arguments);
      } finally {
        f = D;
      }
    };
  };
})(Kd);
Fd.exports = Kd;
var Sy = Fd.exports, Jd = { exports: {} }, Y = {};
/**
 * @license React
 * react.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var yc = Symbol.for("react.transitional.element"), Cy = Symbol.for("react.portal"), wy = Symbol.for("react.fragment"), Ay = Symbol.for("react.strict_mode"), Ny = Symbol.for("react.profiler"), Ey = Symbol.for("react.consumer"), jy = Symbol.for("react.context"), My = Symbol.for("react.forward_ref"), Ty = Symbol.for("react.suspense"), Dy = Symbol.for("react.memo"), Id = Symbol.for("react.lazy"), _y = Symbol.for("react.activity"), Bu = Symbol.iterator;
function Oy(e) {
  return e === null || typeof e != "object" ? null : (e = Bu && e[Bu] || e["@@iterator"], typeof e == "function" ? e : null);
}
var Wd = {
  isMounted: function() {
    return !1;
  },
  enqueueForceUpdate: function() {
  },
  enqueueReplaceState: function() {
  },
  enqueueSetState: function() {
  }
}, $d = Object.assign, Pd = {};
function ol(e, t, n) {
  this.props = e, this.context = t, this.refs = Pd, this.updater = n || Wd;
}
ol.prototype.isReactComponent = {};
ol.prototype.setState = function(e, t) {
  if (typeof e != "object" && typeof e != "function" && e != null)
    throw Error(
      "takes an object of state variables to update or a function which returns an object of state variables."
    );
  this.updater.enqueueSetState(this, e, t, "setState");
};
ol.prototype.forceUpdate = function(e) {
  this.updater.enqueueForceUpdate(this, e, "forceUpdate");
};
function em() {
}
em.prototype = ol.prototype;
function bc(e, t, n) {
  this.props = e, this.context = t, this.refs = Pd, this.updater = n || Wd;
}
var xc = bc.prototype = new em();
xc.constructor = bc;
$d(xc, ol.prototype);
xc.isPureReactComponent = !0;
var Hu = Array.isArray;
function vr() {
}
var ve = { H: null, A: null, T: null, S: null }, tm = Object.prototype.hasOwnProperty;
function Sc(e, t, n) {
  var a = n.ref;
  return {
    $$typeof: yc,
    type: e,
    key: t,
    ref: a !== void 0 ? a : null,
    props: n
  };
}
function zy(e, t) {
  return Sc(e.type, t, e.props);
}
function Cc(e) {
  return typeof e == "object" && e !== null && e.$$typeof === yc;
}
function Ry(e) {
  var t = { "=": "=0", ":": "=2" };
  return "$" + e.replace(/[=:]/g, function(n) {
    return t[n];
  });
}
var Gu = /\/+/g;
function js(e, t) {
  return typeof e == "object" && e !== null && e.key != null ? Ry("" + e.key) : t.toString(36);
}
function ky(e) {
  switch (e.status) {
    case "fulfilled":
      return e.value;
    case "rejected":
      throw e.reason;
    default:
      switch (typeof e.status == "string" ? e.then(vr, vr) : (e.status = "pending", e.then(
        function(t) {
          e.status === "pending" && (e.status = "fulfilled", e.value = t);
        },
        function(t) {
          e.status === "pending" && (e.status = "rejected", e.reason = t);
        }
      )), e.status) {
        case "fulfilled":
          return e.value;
        case "rejected":
          throw e.reason;
      }
  }
  throw e;
}
function Ca(e, t, n, a, l) {
  var i = typeof e;
  (i === "undefined" || i === "boolean") && (e = null);
  var o = !1;
  if (e === null) o = !0;
  else
    switch (i) {
      case "bigint":
      case "string":
      case "number":
        o = !0;
        break;
      case "object":
        switch (e.$$typeof) {
          case yc:
          case Cy:
            o = !0;
            break;
          case Id:
            return o = e._init, Ca(
              o(e._payload),
              t,
              n,
              a,
              l
            );
        }
    }
  if (o)
    return l = l(e), o = a === "" ? "." + js(e, 0) : a, Hu(l) ? (n = "", o != null && (n = o.replace(Gu, "$&/") + "/"), Ca(l, t, n, "", function(u) {
      return u;
    })) : l != null && (Cc(l) && (l = zy(
      l,
      n + (l.key == null || e && e.key === l.key ? "" : ("" + l.key).replace(
        Gu,
        "$&/"
      ) + "/") + o
    )), t.push(l)), 1;
  o = 0;
  var s = a === "" ? "." : a + ":";
  if (Hu(e))
    for (var c = 0; c < e.length; c++)
      a = e[c], i = s + js(a, c), o += Ca(
        a,
        t,
        n,
        i,
        l
      );
  else if (c = Oy(e), typeof c == "function")
    for (e = c.call(e), c = 0; !(a = e.next()).done; )
      a = a.value, i = s + js(a, c++), o += Ca(
        a,
        t,
        n,
        i,
        l
      );
  else if (i === "object") {
    if (typeof e.then == "function")
      return Ca(
        ky(e),
        t,
        n,
        a,
        l
      );
    throw t = String(e), Error(
      "Objects are not valid as a React child (found: " + (t === "[object Object]" ? "object with keys {" + Object.keys(e).join(", ") + "}" : t) + "). If you meant to render a collection of children, use an array instead."
    );
  }
  return o;
}
function Ti(e, t, n) {
  if (e == null) return e;
  var a = [], l = 0;
  return Ca(e, a, "", "", function(i) {
    return t.call(n, i, l++);
  }), a;
}
function Uy(e) {
  if (e._status === -1) {
    var t = e._result;
    t = t(), t.then(
      function(n) {
        (e._status === 0 || e._status === -1) && (e._status = 1, e._result = n);
      },
      function(n) {
        (e._status === 0 || e._status === -1) && (e._status = 2, e._result = n);
      }
    ), e._status === -1 && (e._status = 0, e._result = t);
  }
  if (e._status === 1) return e._result.default;
  throw e._result;
}
var Yu = typeof reportError == "function" ? reportError : function(e) {
  if (typeof window == "object" && typeof window.ErrorEvent == "function") {
    var t = new window.ErrorEvent("error", {
      bubbles: !0,
      cancelable: !0,
      message: typeof e == "object" && e !== null && typeof e.message == "string" ? String(e.message) : String(e),
      error: e
    });
    if (!window.dispatchEvent(t)) return;
  } else if (typeof process == "object" && typeof process.emit == "function") {
    process.emit("uncaughtException", e);
    return;
  }
  console.error(e);
}, Vy = {
  map: Ti,
  forEach: function(e, t, n) {
    Ti(
      e,
      function() {
        t.apply(this, arguments);
      },
      n
    );
  },
  count: function(e) {
    var t = 0;
    return Ti(e, function() {
      t++;
    }), t;
  },
  toArray: function(e) {
    return Ti(e, function(t) {
      return t;
    }) || [];
  },
  only: function(e) {
    if (!Cc(e))
      throw Error(
        "React.Children.only expected to receive a single React element child."
      );
    return e;
  }
};
Y.Activity = _y;
Y.Children = Vy;
Y.Component = ol;
Y.Fragment = wy;
Y.Profiler = Ny;
Y.PureComponent = bc;
Y.StrictMode = Ay;
Y.Suspense = Ty;
Y.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ve;
Y.__COMPILER_RUNTIME = {
  __proto__: null,
  c: function(e) {
    return ve.H.useMemoCache(e);
  }
};
Y.cache = function(e) {
  return function() {
    return e.apply(null, arguments);
  };
};
Y.cacheSignal = function() {
  return null;
};
Y.cloneElement = function(e, t, n) {
  if (e == null)
    throw Error(
      "The argument must be a React element, but you passed " + e + "."
    );
  var a = $d({}, e.props), l = e.key;
  if (t != null)
    for (i in t.key !== void 0 && (l = "" + t.key), t)
      !tm.call(t, i) || i === "key" || i === "__self" || i === "__source" || i === "ref" && t.ref === void 0 || (a[i] = t[i]);
  var i = arguments.length - 2;
  if (i === 1) a.children = n;
  else if (1 < i) {
    for (var o = Array(i), s = 0; s < i; s++)
      o[s] = arguments[s + 2];
    a.children = o;
  }
  return Sc(e.type, l, a);
};
Y.createContext = function(e) {
  return e = {
    $$typeof: jy,
    _currentValue: e,
    _currentValue2: e,
    _threadCount: 0,
    Provider: null,
    Consumer: null
  }, e.Provider = e, e.Consumer = {
    $$typeof: Ey,
    _context: e
  }, e;
};
Y.createElement = function(e, t, n) {
  var a, l = {}, i = null;
  if (t != null)
    for (a in t.key !== void 0 && (i = "" + t.key), t)
      tm.call(t, a) && a !== "key" && a !== "__self" && a !== "__source" && (l[a] = t[a]);
  var o = arguments.length - 2;
  if (o === 1) l.children = n;
  else if (1 < o) {
    for (var s = Array(o), c = 0; c < o; c++)
      s[c] = arguments[c + 2];
    l.children = s;
  }
  if (e && e.defaultProps)
    for (a in o = e.defaultProps, o)
      l[a] === void 0 && (l[a] = o[a]);
  return Sc(e, i, l);
};
Y.createRef = function() {
  return { current: null };
};
Y.forwardRef = function(e) {
  return { $$typeof: My, render: e };
};
Y.isValidElement = Cc;
Y.lazy = function(e) {
  return {
    $$typeof: Id,
    _payload: { _status: -1, _result: e },
    _init: Uy
  };
};
Y.memo = function(e, t) {
  return {
    $$typeof: Dy,
    type: e,
    compare: t === void 0 ? null : t
  };
};
Y.startTransition = function(e) {
  var t = ve.T, n = {};
  ve.T = n;
  try {
    var a = e(), l = ve.S;
    l !== null && l(n, a), typeof a == "object" && a !== null && typeof a.then == "function" && a.then(vr, Yu);
  } catch (i) {
    Yu(i);
  } finally {
    t !== null && n.types !== null && (t.types = n.types), ve.T = t;
  }
};
Y.unstable_useCacheRefresh = function() {
  return ve.H.useCacheRefresh();
};
Y.use = function(e) {
  return ve.H.use(e);
};
Y.useActionState = function(e, t, n) {
  return ve.H.useActionState(e, t, n);
};
Y.useCallback = function(e, t) {
  return ve.H.useCallback(e, t);
};
Y.useContext = function(e) {
  return ve.H.useContext(e);
};
Y.useDebugValue = function() {
};
Y.useDeferredValue = function(e, t) {
  return ve.H.useDeferredValue(e, t);
};
Y.useEffect = function(e, t) {
  return ve.H.useEffect(e, t);
};
Y.useEffectEvent = function(e) {
  return ve.H.useEffectEvent(e);
};
Y.useId = function() {
  return ve.H.useId();
};
Y.useImperativeHandle = function(e, t, n) {
  return ve.H.useImperativeHandle(e, t, n);
};
Y.useInsertionEffect = function(e, t) {
  return ve.H.useInsertionEffect(e, t);
};
Y.useLayoutEffect = function(e, t) {
  return ve.H.useLayoutEffect(e, t);
};
Y.useMemo = function(e, t) {
  return ve.H.useMemo(e, t);
};
Y.useOptimistic = function(e, t) {
  return ve.H.useOptimistic(e, t);
};
Y.useReducer = function(e, t, n) {
  return ve.H.useReducer(e, t, n);
};
Y.useRef = function(e) {
  return ve.H.useRef(e);
};
Y.useState = function(e) {
  return ve.H.useState(e);
};
Y.useSyncExternalStore = function(e, t, n) {
  return ve.H.useSyncExternalStore(
    e,
    t,
    n
  );
};
Y.useTransition = function() {
  return ve.H.useTransition();
};
Y.version = "19.2.4";
Jd.exports = Y;
var v = Jd.exports;
const xe = /* @__PURE__ */ yy(v), wc = /* @__PURE__ */ py({
  __proto__: null,
  default: xe
}, [v]);
var nm = { exports: {} }, Ke = {};
/**
 * @license React
 * react-dom.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Ly = v;
function am(e) {
  var t = "https://react.dev/errors/" + e;
  if (1 < arguments.length) {
    t += "?args[]=" + encodeURIComponent(arguments[1]);
    for (var n = 2; n < arguments.length; n++)
      t += "&args[]=" + encodeURIComponent(arguments[n]);
  }
  return "Minified React error #" + e + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
}
function fn() {
}
var Fe = {
  d: {
    f: fn,
    r: function() {
      throw Error(am(522));
    },
    D: fn,
    C: fn,
    L: fn,
    m: fn,
    X: fn,
    S: fn,
    M: fn
  },
  p: 0,
  findDOMNode: null
}, By = Symbol.for("react.portal");
function Hy(e, t, n) {
  var a = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
  return {
    $$typeof: By,
    key: a == null ? null : "" + a,
    children: e,
    containerInfo: t,
    implementation: n
  };
}
var Vl = Ly.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
function es(e, t) {
  if (e === "font") return "";
  if (typeof t == "string")
    return t === "use-credentials" ? t : "";
}
Ke.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = Fe;
Ke.createPortal = function(e, t) {
  var n = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
  if (!t || t.nodeType !== 1 && t.nodeType !== 9 && t.nodeType !== 11)
    throw Error(am(299));
  return Hy(e, t, null, n);
};
Ke.flushSync = function(e) {
  var t = Vl.T, n = Fe.p;
  try {
    if (Vl.T = null, Fe.p = 2, e) return e();
  } finally {
    Vl.T = t, Fe.p = n, Fe.d.f();
  }
};
Ke.preconnect = function(e, t) {
  typeof e == "string" && (t ? (t = t.crossOrigin, t = typeof t == "string" ? t === "use-credentials" ? t : "" : void 0) : t = null, Fe.d.C(e, t));
};
Ke.prefetchDNS = function(e) {
  typeof e == "string" && Fe.d.D(e);
};
Ke.preinit = function(e, t) {
  if (typeof e == "string" && t && typeof t.as == "string") {
    var n = t.as, a = es(n, t.crossOrigin), l = typeof t.integrity == "string" ? t.integrity : void 0, i = typeof t.fetchPriority == "string" ? t.fetchPriority : void 0;
    n === "style" ? Fe.d.S(
      e,
      typeof t.precedence == "string" ? t.precedence : void 0,
      {
        crossOrigin: a,
        integrity: l,
        fetchPriority: i
      }
    ) : n === "script" && Fe.d.X(e, {
      crossOrigin: a,
      integrity: l,
      fetchPriority: i,
      nonce: typeof t.nonce == "string" ? t.nonce : void 0
    });
  }
};
Ke.preinitModule = function(e, t) {
  if (typeof e == "string")
    if (typeof t == "object" && t !== null) {
      if (t.as == null || t.as === "script") {
        var n = es(
          t.as,
          t.crossOrigin
        );
        Fe.d.M(e, {
          crossOrigin: n,
          integrity: typeof t.integrity == "string" ? t.integrity : void 0,
          nonce: typeof t.nonce == "string" ? t.nonce : void 0
        });
      }
    } else t == null && Fe.d.M(e);
};
Ke.preload = function(e, t) {
  if (typeof e == "string" && typeof t == "object" && t !== null && typeof t.as == "string") {
    var n = t.as, a = es(n, t.crossOrigin);
    Fe.d.L(e, n, {
      crossOrigin: a,
      integrity: typeof t.integrity == "string" ? t.integrity : void 0,
      nonce: typeof t.nonce == "string" ? t.nonce : void 0,
      type: typeof t.type == "string" ? t.type : void 0,
      fetchPriority: typeof t.fetchPriority == "string" ? t.fetchPriority : void 0,
      referrerPolicy: typeof t.referrerPolicy == "string" ? t.referrerPolicy : void 0,
      imageSrcSet: typeof t.imageSrcSet == "string" ? t.imageSrcSet : void 0,
      imageSizes: typeof t.imageSizes == "string" ? t.imageSizes : void 0,
      media: typeof t.media == "string" ? t.media : void 0
    });
  }
};
Ke.preloadModule = function(e, t) {
  if (typeof e == "string")
    if (t) {
      var n = es(t.as, t.crossOrigin);
      Fe.d.m(e, {
        as: typeof t.as == "string" && t.as !== "script" ? t.as : void 0,
        crossOrigin: n,
        integrity: typeof t.integrity == "string" ? t.integrity : void 0
      });
    } else Fe.d.m(e);
};
Ke.requestFormReset = function(e) {
  Fe.d.r(e);
};
Ke.unstable_batchedUpdates = function(e, t) {
  return e(t);
};
Ke.useFormState = function(e, t, n) {
  return Vl.H.useFormState(e, t, n);
};
Ke.useFormStatus = function() {
  return Vl.H.useHostTransitionStatus();
};
Ke.version = "19.2.4";
function lm() {
  if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
    try {
      __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(lm);
    } catch (e) {
      console.error(e);
    }
}
lm(), nm.exports = Ke;
var Gy = nm.exports;
/**
 * @license React
 * react-dom-client.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Re = Sy, im = v, Yy = Gy;
function _(e) {
  var t = "https://react.dev/errors/" + e;
  if (1 < arguments.length) {
    t += "?args[]=" + encodeURIComponent(arguments[1]);
    for (var n = 2; n < arguments.length; n++)
      t += "&args[]=" + encodeURIComponent(arguments[n]);
  }
  return "Minified React error #" + e + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
}
function om(e) {
  return !(!e || e.nodeType !== 1 && e.nodeType !== 9 && e.nodeType !== 11);
}
function di(e) {
  var t = e, n = e;
  if (e.alternate) for (; t.return; ) t = t.return;
  else {
    e = t;
    do
      t = e, t.flags & 4098 && (n = t.return), e = t.return;
    while (e);
  }
  return t.tag === 3 ? n : null;
}
function sm(e) {
  if (e.tag === 13) {
    var t = e.memoizedState;
    if (t === null && (e = e.alternate, e !== null && (t = e.memoizedState)), t !== null) return t.dehydrated;
  }
  return null;
}
function rm(e) {
  if (e.tag === 31) {
    var t = e.memoizedState;
    if (t === null && (e = e.alternate, e !== null && (t = e.memoizedState)), t !== null) return t.dehydrated;
  }
  return null;
}
function qu(e) {
  if (di(e) !== e)
    throw Error(_(188));
}
function qy(e) {
  var t = e.alternate;
  if (!t) {
    if (t = di(e), t === null) throw Error(_(188));
    return t !== e ? null : e;
  }
  for (var n = e, a = t; ; ) {
    var l = n.return;
    if (l === null) break;
    var i = l.alternate;
    if (i === null) {
      if (a = l.return, a !== null) {
        n = a;
        continue;
      }
      break;
    }
    if (l.child === i.child) {
      for (i = l.child; i; ) {
        if (i === n) return qu(l), e;
        if (i === a) return qu(l), t;
        i = i.sibling;
      }
      throw Error(_(188));
    }
    if (n.return !== a.return) n = l, a = i;
    else {
      for (var o = !1, s = l.child; s; ) {
        if (s === n) {
          o = !0, n = l, a = i;
          break;
        }
        if (s === a) {
          o = !0, a = l, n = i;
          break;
        }
        s = s.sibling;
      }
      if (!o) {
        for (s = i.child; s; ) {
          if (s === n) {
            o = !0, n = i, a = l;
            break;
          }
          if (s === a) {
            o = !0, a = i, n = l;
            break;
          }
          s = s.sibling;
        }
        if (!o) throw Error(_(189));
      }
    }
    if (n.alternate !== a) throw Error(_(190));
  }
  if (n.tag !== 3) throw Error(_(188));
  return n.stateNode.current === n ? e : t;
}
function cm(e) {
  var t = e.tag;
  if (t === 5 || t === 26 || t === 27 || t === 6) return e;
  for (e = e.child; e !== null; ) {
    if (t = cm(e), t !== null) return t;
    e = e.sibling;
  }
  return null;
}
var pe = Object.assign, Xy = Symbol.for("react.element"), Di = Symbol.for("react.transitional.element"), Ol = Symbol.for("react.portal"), Na = Symbol.for("react.fragment"), um = Symbol.for("react.strict_mode"), pr = Symbol.for("react.profiler"), fm = Symbol.for("react.consumer"), qt = Symbol.for("react.context"), Ac = Symbol.for("react.forward_ref"), yr = Symbol.for("react.suspense"), br = Symbol.for("react.suspense_list"), Nc = Symbol.for("react.memo"), mn = Symbol.for("react.lazy"), xr = Symbol.for("react.activity"), Qy = Symbol.for("react.memo_cache_sentinel"), Xu = Symbol.iterator;
function wl(e) {
  return e === null || typeof e != "object" ? null : (e = Xu && e[Xu] || e["@@iterator"], typeof e == "function" ? e : null);
}
var Zy = Symbol.for("react.client.reference");
function Sr(e) {
  if (e == null) return null;
  if (typeof e == "function")
    return e.$$typeof === Zy ? null : e.displayName || e.name || null;
  if (typeof e == "string") return e;
  switch (e) {
    case Na:
      return "Fragment";
    case pr:
      return "Profiler";
    case um:
      return "StrictMode";
    case yr:
      return "Suspense";
    case br:
      return "SuspenseList";
    case xr:
      return "Activity";
  }
  if (typeof e == "object")
    switch (e.$$typeof) {
      case Ol:
        return "Portal";
      case qt:
        return e.displayName || "Context";
      case fm:
        return (e._context.displayName || "Context") + ".Consumer";
      case Ac:
        var t = e.render;
        return e = e.displayName, e || (e = t.displayName || t.name || "", e = e !== "" ? "ForwardRef(" + e + ")" : "ForwardRef"), e;
      case Nc:
        return t = e.displayName || null, t !== null ? t : Sr(e.type) || "Memo";
      case mn:
        t = e._payload, e = e._init;
        try {
          return Sr(e(t));
        } catch {
        }
    }
  return null;
}
var zl = Array.isArray, G = im.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, le = Yy.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, Pn = {
  pending: !1,
  data: null,
  method: null,
  action: null
}, Cr = [], Ea = -1;
function _t(e) {
  return { current: e };
}
function Le(e) {
  0 > Ea || (e.current = Cr[Ea], Cr[Ea] = null, Ea--);
}
function de(e, t) {
  Ea++, Cr[Ea] = e.current, e.current = t;
}
var Dt = _t(null), Wl = _t(null), En = _t(null), mo = _t(null);
function ho(e, t) {
  switch (de(En, t), de(Wl, e), de(Dt, null), t.nodeType) {
    case 9:
    case 11:
      e = (e = t.documentElement) && (e = e.namespaceURI) ? Wf(e) : 0;
      break;
    default:
      if (e = t.tagName, t = t.namespaceURI)
        t = Wf(t), e = _g(t, e);
      else
        switch (e) {
          case "svg":
            e = 1;
            break;
          case "math":
            e = 2;
            break;
          default:
            e = 0;
        }
  }
  Le(Dt), de(Dt, e);
}
function Fa() {
  Le(Dt), Le(Wl), Le(En);
}
function wr(e) {
  e.memoizedState !== null && de(mo, e);
  var t = Dt.current, n = _g(t, e.type);
  t !== n && (de(Wl, e), de(Dt, n));
}
function go(e) {
  Wl.current === e && (Le(Dt), Le(Wl)), mo.current === e && (Le(mo), ri._currentValue = Pn);
}
var Ms, Qu;
function Kn(e) {
  if (Ms === void 0)
    try {
      throw Error();
    } catch (n) {
      var t = n.stack.trim().match(/\n( *(at )?)/);
      Ms = t && t[1] || "", Qu = -1 < n.stack.indexOf(`
    at`) ? " (<anonymous>)" : -1 < n.stack.indexOf("@") ? "@unknown:0:0" : "";
    }
  return `
` + Ms + e + Qu;
}
var Ts = !1;
function Ds(e, t) {
  if (!e || Ts) return "";
  Ts = !0;
  var n = Error.prepareStackTrace;
  Error.prepareStackTrace = void 0;
  try {
    var a = {
      DetermineComponentFrameRoot: function() {
        try {
          if (t) {
            var g = function() {
              throw Error();
            };
            if (Object.defineProperty(g.prototype, "props", {
              set: function() {
                throw Error();
              }
            }), typeof Reflect == "object" && Reflect.construct) {
              try {
                Reflect.construct(g, []);
              } catch (p) {
                var f = p;
              }
              Reflect.construct(e, [], g);
            } else {
              try {
                g.call();
              } catch (p) {
                f = p;
              }
              e.call(g.prototype);
            }
          } else {
            try {
              throw Error();
            } catch (p) {
              f = p;
            }
            (g = e()) && typeof g.catch == "function" && g.catch(function() {
            });
          }
        } catch (p) {
          if (p && f && typeof p.stack == "string")
            return [p.stack, f.stack];
        }
        return [null, null];
      }
    };
    a.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
    var l = Object.getOwnPropertyDescriptor(
      a.DetermineComponentFrameRoot,
      "name"
    );
    l && l.configurable && Object.defineProperty(
      a.DetermineComponentFrameRoot,
      "name",
      { value: "DetermineComponentFrameRoot" }
    );
    var i = a.DetermineComponentFrameRoot(), o = i[0], s = i[1];
    if (o && s) {
      var c = o.split(`
`), u = s.split(`
`);
      for (l = a = 0; a < c.length && !c[a].includes("DetermineComponentFrameRoot"); )
        a++;
      for (; l < u.length && !u[l].includes(
        "DetermineComponentFrameRoot"
      ); )
        l++;
      if (a === c.length || l === u.length)
        for (a = c.length - 1, l = u.length - 1; 1 <= a && 0 <= l && c[a] !== u[l]; )
          l--;
      for (; 1 <= a && 0 <= l; a--, l--)
        if (c[a] !== u[l]) {
          if (a !== 1 || l !== 1)
            do
              if (a--, l--, 0 > l || c[a] !== u[l]) {
                var m = `
` + c[a].replace(" at new ", " at ");
                return e.displayName && m.includes("<anonymous>") && (m = m.replace("<anonymous>", e.displayName)), m;
              }
            while (1 <= a && 0 <= l);
          break;
        }
    }
  } finally {
    Ts = !1, Error.prepareStackTrace = n;
  }
  return (n = e ? e.displayName || e.name : "") ? Kn(n) : "";
}
function Fy(e, t) {
  switch (e.tag) {
    case 26:
    case 27:
    case 5:
      return Kn(e.type);
    case 16:
      return Kn("Lazy");
    case 13:
      return e.child !== t && t !== null ? Kn("Suspense Fallback") : Kn("Suspense");
    case 19:
      return Kn("SuspenseList");
    case 0:
    case 15:
      return Ds(e.type, !1);
    case 11:
      return Ds(e.type.render, !1);
    case 1:
      return Ds(e.type, !0);
    case 31:
      return Kn("Activity");
    default:
      return "";
  }
}
function Zu(e) {
  try {
    var t = "", n = null;
    do
      t += Fy(e, n), n = e, e = e.return;
    while (e);
    return t;
  } catch (a) {
    return `
Error generating stack: ` + a.message + `
` + a.stack;
  }
}
var Ar = Object.prototype.hasOwnProperty, Ec = Re.unstable_scheduleCallback, _s = Re.unstable_cancelCallback, Ky = Re.unstable_shouldYield, Jy = Re.unstable_requestPaint, ot = Re.unstable_now, Iy = Re.unstable_getCurrentPriorityLevel, dm = Re.unstable_ImmediatePriority, mm = Re.unstable_UserBlockingPriority, vo = Re.unstable_NormalPriority, Wy = Re.unstable_LowPriority, hm = Re.unstable_IdlePriority, $y = Re.log, Py = Re.unstable_setDisableYieldValue, mi = null, st = null;
function xn(e) {
  if (typeof $y == "function" && Py(e), st && typeof st.setStrictMode == "function")
    try {
      st.setStrictMode(mi, e);
    } catch {
    }
}
var rt = Math.clz32 ? Math.clz32 : n0, e0 = Math.log, t0 = Math.LN2;
function n0(e) {
  return e >>>= 0, e === 0 ? 32 : 31 - (e0(e) / t0 | 0) | 0;
}
var _i = 256, Oi = 262144, zi = 4194304;
function Jn(e) {
  var t = e & 42;
  if (t !== 0) return t;
  switch (e & -e) {
    case 1:
      return 1;
    case 2:
      return 2;
    case 4:
      return 4;
    case 8:
      return 8;
    case 16:
      return 16;
    case 32:
      return 32;
    case 64:
      return 64;
    case 128:
      return 128;
    case 256:
    case 512:
    case 1024:
    case 2048:
    case 4096:
    case 8192:
    case 16384:
    case 32768:
    case 65536:
    case 131072:
      return e & 261888;
    case 262144:
    case 524288:
    case 1048576:
    case 2097152:
      return e & 3932160;
    case 4194304:
    case 8388608:
    case 16777216:
    case 33554432:
      return e & 62914560;
    case 67108864:
      return 67108864;
    case 134217728:
      return 134217728;
    case 268435456:
      return 268435456;
    case 536870912:
      return 536870912;
    case 1073741824:
      return 0;
    default:
      return e;
  }
}
function ts(e, t, n) {
  var a = e.pendingLanes;
  if (a === 0) return 0;
  var l = 0, i = e.suspendedLanes, o = e.pingedLanes;
  e = e.warmLanes;
  var s = a & 134217727;
  return s !== 0 ? (a = s & ~i, a !== 0 ? l = Jn(a) : (o &= s, o !== 0 ? l = Jn(o) : n || (n = s & ~e, n !== 0 && (l = Jn(n))))) : (s = a & ~i, s !== 0 ? l = Jn(s) : o !== 0 ? l = Jn(o) : n || (n = a & ~e, n !== 0 && (l = Jn(n)))), l === 0 ? 0 : t !== 0 && t !== l && !(t & i) && (i = l & -l, n = t & -t, i >= n || i === 32 && (n & 4194048) !== 0) ? t : l;
}
function hi(e, t) {
  return (e.pendingLanes & ~(e.suspendedLanes & ~e.pingedLanes) & t) === 0;
}
function a0(e, t) {
  switch (e) {
    case 1:
    case 2:
    case 4:
    case 8:
    case 64:
      return t + 250;
    case 16:
    case 32:
    case 128:
    case 256:
    case 512:
    case 1024:
    case 2048:
    case 4096:
    case 8192:
    case 16384:
    case 32768:
    case 65536:
    case 131072:
    case 262144:
    case 524288:
    case 1048576:
    case 2097152:
      return t + 5e3;
    case 4194304:
    case 8388608:
    case 16777216:
    case 33554432:
      return -1;
    case 67108864:
    case 134217728:
    case 268435456:
    case 536870912:
    case 1073741824:
      return -1;
    default:
      return -1;
  }
}
function gm() {
  var e = zi;
  return zi <<= 1, !(zi & 62914560) && (zi = 4194304), e;
}
function Os(e) {
  for (var t = [], n = 0; 31 > n; n++) t.push(e);
  return t;
}
function gi(e, t) {
  e.pendingLanes |= t, t !== 268435456 && (e.suspendedLanes = 0, e.pingedLanes = 0, e.warmLanes = 0);
}
function l0(e, t, n, a, l, i) {
  var o = e.pendingLanes;
  e.pendingLanes = n, e.suspendedLanes = 0, e.pingedLanes = 0, e.warmLanes = 0, e.expiredLanes &= n, e.entangledLanes &= n, e.errorRecoveryDisabledLanes &= n, e.shellSuspendCounter = 0;
  var s = e.entanglements, c = e.expirationTimes, u = e.hiddenUpdates;
  for (n = o & ~n; 0 < n; ) {
    var m = 31 - rt(n), g = 1 << m;
    s[m] = 0, c[m] = -1;
    var f = u[m];
    if (f !== null)
      for (u[m] = null, m = 0; m < f.length; m++) {
        var p = f[m];
        p !== null && (p.lane &= -536870913);
      }
    n &= ~g;
  }
  a !== 0 && vm(e, a, 0), i !== 0 && l === 0 && e.tag !== 0 && (e.suspendedLanes |= i & ~(o & ~t));
}
function vm(e, t, n) {
  e.pendingLanes |= t, e.suspendedLanes &= ~t;
  var a = 31 - rt(t);
  e.entangledLanes |= t, e.entanglements[a] = e.entanglements[a] | 1073741824 | n & 261930;
}
function pm(e, t) {
  var n = e.entangledLanes |= t;
  for (e = e.entanglements; n; ) {
    var a = 31 - rt(n), l = 1 << a;
    l & t | e[a] & t && (e[a] |= t), n &= ~l;
  }
}
function ym(e, t) {
  var n = t & -t;
  return n = n & 42 ? 1 : jc(n), n & (e.suspendedLanes | t) ? 0 : n;
}
function jc(e) {
  switch (e) {
    case 2:
      e = 1;
      break;
    case 8:
      e = 4;
      break;
    case 32:
      e = 16;
      break;
    case 256:
    case 512:
    case 1024:
    case 2048:
    case 4096:
    case 8192:
    case 16384:
    case 32768:
    case 65536:
    case 131072:
    case 262144:
    case 524288:
    case 1048576:
    case 2097152:
    case 4194304:
    case 8388608:
    case 16777216:
    case 33554432:
      e = 128;
      break;
    case 268435456:
      e = 134217728;
      break;
    default:
      e = 0;
  }
  return e;
}
function Mc(e) {
  return e &= -e, 2 < e ? 8 < e ? e & 134217727 ? 32 : 268435456 : 8 : 2;
}
function bm() {
  var e = le.p;
  return e !== 0 ? e : (e = window.event, e === void 0 ? 32 : Yg(e.type));
}
function Fu(e, t) {
  var n = le.p;
  try {
    return le.p = e, t();
  } finally {
    le.p = n;
  }
}
var Gn = Math.random().toString(36).slice(2), Ge = "__reactFiber$" + Gn, et = "__reactProps$" + Gn, sl = "__reactContainer$" + Gn, Nr = "__reactEvents$" + Gn, i0 = "__reactListeners$" + Gn, o0 = "__reactHandles$" + Gn, Ku = "__reactResources$" + Gn, vi = "__reactMarker$" + Gn;
function Tc(e) {
  delete e[Ge], delete e[et], delete e[Nr], delete e[i0], delete e[o0];
}
function ja(e) {
  var t = e[Ge];
  if (t) return t;
  for (var n = e.parentNode; n; ) {
    if (t = n[sl] || n[Ge]) {
      if (n = t.alternate, t.child !== null || n !== null && n.child !== null)
        for (e = nd(e); e !== null; ) {
          if (n = e[Ge]) return n;
          e = nd(e);
        }
      return t;
    }
    e = n, n = e.parentNode;
  }
  return null;
}
function rl(e) {
  if (e = e[Ge] || e[sl]) {
    var t = e.tag;
    if (t === 5 || t === 6 || t === 13 || t === 31 || t === 26 || t === 27 || t === 3)
      return e;
  }
  return null;
}
function Rl(e) {
  var t = e.tag;
  if (t === 5 || t === 26 || t === 27 || t === 6) return e.stateNode;
  throw Error(_(33));
}
function Ba(e) {
  var t = e[Ku];
  return t || (t = e[Ku] = { hoistableStyles: /* @__PURE__ */ new Map(), hoistableScripts: /* @__PURE__ */ new Map() }), t;
}
function Ue(e) {
  e[vi] = !0;
}
var xm = /* @__PURE__ */ new Set(), Sm = {};
function ua(e, t) {
  Ka(e, t), Ka(e + "Capture", t);
}
function Ka(e, t) {
  for (Sm[e] = t, e = 0; e < t.length; e++)
    xm.add(t[e]);
}
var s0 = RegExp(
  "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"
), Ju = {}, Iu = {};
function r0(e) {
  return Ar.call(Iu, e) ? !0 : Ar.call(Ju, e) ? !1 : s0.test(e) ? Iu[e] = !0 : (Ju[e] = !0, !1);
}
function Ii(e, t, n) {
  if (r0(t))
    if (n === null) e.removeAttribute(t);
    else {
      switch (typeof n) {
        case "undefined":
        case "function":
        case "symbol":
          e.removeAttribute(t);
          return;
        case "boolean":
          var a = t.toLowerCase().slice(0, 5);
          if (a !== "data-" && a !== "aria-") {
            e.removeAttribute(t);
            return;
          }
      }
      e.setAttribute(t, "" + n);
    }
}
function Ri(e, t, n) {
  if (n === null) e.removeAttribute(t);
  else {
    switch (typeof n) {
      case "undefined":
      case "function":
      case "symbol":
      case "boolean":
        e.removeAttribute(t);
        return;
    }
    e.setAttribute(t, "" + n);
  }
}
function kt(e, t, n, a) {
  if (a === null) e.removeAttribute(n);
  else {
    switch (typeof a) {
      case "undefined":
      case "function":
      case "symbol":
      case "boolean":
        e.removeAttribute(n);
        return;
    }
    e.setAttributeNS(t, n, "" + a);
  }
}
function mt(e) {
  switch (typeof e) {
    case "bigint":
    case "boolean":
    case "number":
    case "string":
    case "undefined":
      return e;
    case "object":
      return e;
    default:
      return "";
  }
}
function Cm(e) {
  var t = e.type;
  return (e = e.nodeName) && e.toLowerCase() === "input" && (t === "checkbox" || t === "radio");
}
function c0(e, t, n) {
  var a = Object.getOwnPropertyDescriptor(
    e.constructor.prototype,
    t
  );
  if (!e.hasOwnProperty(t) && typeof a < "u" && typeof a.get == "function" && typeof a.set == "function") {
    var l = a.get, i = a.set;
    return Object.defineProperty(e, t, {
      configurable: !0,
      get: function() {
        return l.call(this);
      },
      set: function(o) {
        n = "" + o, i.call(this, o);
      }
    }), Object.defineProperty(e, t, {
      enumerable: a.enumerable
    }), {
      getValue: function() {
        return n;
      },
      setValue: function(o) {
        n = "" + o;
      },
      stopTracking: function() {
        e._valueTracker = null, delete e[t];
      }
    };
  }
}
function Er(e) {
  if (!e._valueTracker) {
    var t = Cm(e) ? "checked" : "value";
    e._valueTracker = c0(
      e,
      t,
      "" + e[t]
    );
  }
}
function wm(e) {
  if (!e) return !1;
  var t = e._valueTracker;
  if (!t) return !0;
  var n = t.getValue(), a = "";
  return e && (a = Cm(e) ? e.checked ? "true" : "false" : e.value), e = a, e !== n ? (t.setValue(e), !0) : !1;
}
function po(e) {
  if (e = e || (typeof document < "u" ? document : void 0), typeof e > "u") return null;
  try {
    return e.activeElement || e.body;
  } catch {
    return e.body;
  }
}
var u0 = /[\n"\\]/g;
function vt(e) {
  return e.replace(
    u0,
    function(t) {
      return "\\" + t.charCodeAt(0).toString(16) + " ";
    }
  );
}
function jr(e, t, n, a, l, i, o, s) {
  e.name = "", o != null && typeof o != "function" && typeof o != "symbol" && typeof o != "boolean" ? e.type = o : e.removeAttribute("type"), t != null ? o === "number" ? (t === 0 && e.value === "" || e.value != t) && (e.value = "" + mt(t)) : e.value !== "" + mt(t) && (e.value = "" + mt(t)) : o !== "submit" && o !== "reset" || e.removeAttribute("value"), t != null ? Mr(e, o, mt(t)) : n != null ? Mr(e, o, mt(n)) : a != null && e.removeAttribute("value"), l == null && i != null && (e.defaultChecked = !!i), l != null && (e.checked = l && typeof l != "function" && typeof l != "symbol"), s != null && typeof s != "function" && typeof s != "symbol" && typeof s != "boolean" ? e.name = "" + mt(s) : e.removeAttribute("name");
}
function Am(e, t, n, a, l, i, o, s) {
  if (i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" && (e.type = i), t != null || n != null) {
    if (!(i !== "submit" && i !== "reset" || t != null)) {
      Er(e);
      return;
    }
    n = n != null ? "" + mt(n) : "", t = t != null ? "" + mt(t) : n, s || t === e.value || (e.value = t), e.defaultValue = t;
  }
  a = a ?? l, a = typeof a != "function" && typeof a != "symbol" && !!a, e.checked = s ? e.checked : !!a, e.defaultChecked = !!a, o != null && typeof o != "function" && typeof o != "symbol" && typeof o != "boolean" && (e.name = o), Er(e);
}
function Mr(e, t, n) {
  t === "number" && po(e.ownerDocument) === e || e.defaultValue === "" + n || (e.defaultValue = "" + n);
}
function Ha(e, t, n, a) {
  if (e = e.options, t) {
    t = {};
    for (var l = 0; l < n.length; l++)
      t["$" + n[l]] = !0;
    for (n = 0; n < e.length; n++)
      l = t.hasOwnProperty("$" + e[n].value), e[n].selected !== l && (e[n].selected = l), l && a && (e[n].defaultSelected = !0);
  } else {
    for (n = "" + mt(n), t = null, l = 0; l < e.length; l++) {
      if (e[l].value === n) {
        e[l].selected = !0, a && (e[l].defaultSelected = !0);
        return;
      }
      t !== null || e[l].disabled || (t = e[l]);
    }
    t !== null && (t.selected = !0);
  }
}
function Nm(e, t, n) {
  if (t != null && (t = "" + mt(t), t !== e.value && (e.value = t), n == null)) {
    e.defaultValue !== t && (e.defaultValue = t);
    return;
  }
  e.defaultValue = n != null ? "" + mt(n) : "";
}
function Em(e, t, n, a) {
  if (t == null) {
    if (a != null) {
      if (n != null) throw Error(_(92));
      if (zl(a)) {
        if (1 < a.length) throw Error(_(93));
        a = a[0];
      }
      n = a;
    }
    n == null && (n = ""), t = n;
  }
  n = mt(t), e.defaultValue = n, a = e.textContent, a === n && a !== "" && a !== null && (e.value = a), Er(e);
}
function Ja(e, t) {
  if (t) {
    var n = e.firstChild;
    if (n && n === e.lastChild && n.nodeType === 3) {
      n.nodeValue = t;
      return;
    }
  }
  e.textContent = t;
}
var f0 = new Set(
  "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
    " "
  )
);
function Wu(e, t, n) {
  var a = t.indexOf("--") === 0;
  n == null || typeof n == "boolean" || n === "" ? a ? e.setProperty(t, "") : t === "float" ? e.cssFloat = "" : e[t] = "" : a ? e.setProperty(t, n) : typeof n != "number" || n === 0 || f0.has(t) ? t === "float" ? e.cssFloat = n : e[t] = ("" + n).trim() : e[t] = n + "px";
}
function jm(e, t, n) {
  if (t != null && typeof t != "object")
    throw Error(_(62));
  if (e = e.style, n != null) {
    for (var a in n)
      !n.hasOwnProperty(a) || t != null && t.hasOwnProperty(a) || (a.indexOf("--") === 0 ? e.setProperty(a, "") : a === "float" ? e.cssFloat = "" : e[a] = "");
    for (var l in t)
      a = t[l], t.hasOwnProperty(l) && n[l] !== a && Wu(e, l, a);
  } else
    for (var i in t)
      t.hasOwnProperty(i) && Wu(e, i, t[i]);
}
function Dc(e) {
  if (e.indexOf("-") === -1) return !1;
  switch (e) {
    case "annotation-xml":
    case "color-profile":
    case "font-face":
    case "font-face-src":
    case "font-face-uri":
    case "font-face-format":
    case "font-face-name":
    case "missing-glyph":
      return !1;
    default:
      return !0;
  }
}
var d0 = /* @__PURE__ */ new Map([
  ["acceptCharset", "accept-charset"],
  ["htmlFor", "for"],
  ["httpEquiv", "http-equiv"],
  ["crossOrigin", "crossorigin"],
  ["accentHeight", "accent-height"],
  ["alignmentBaseline", "alignment-baseline"],
  ["arabicForm", "arabic-form"],
  ["baselineShift", "baseline-shift"],
  ["capHeight", "cap-height"],
  ["clipPath", "clip-path"],
  ["clipRule", "clip-rule"],
  ["colorInterpolation", "color-interpolation"],
  ["colorInterpolationFilters", "color-interpolation-filters"],
  ["colorProfile", "color-profile"],
  ["colorRendering", "color-rendering"],
  ["dominantBaseline", "dominant-baseline"],
  ["enableBackground", "enable-background"],
  ["fillOpacity", "fill-opacity"],
  ["fillRule", "fill-rule"],
  ["floodColor", "flood-color"],
  ["floodOpacity", "flood-opacity"],
  ["fontFamily", "font-family"],
  ["fontSize", "font-size"],
  ["fontSizeAdjust", "font-size-adjust"],
  ["fontStretch", "font-stretch"],
  ["fontStyle", "font-style"],
  ["fontVariant", "font-variant"],
  ["fontWeight", "font-weight"],
  ["glyphName", "glyph-name"],
  ["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
  ["glyphOrientationVertical", "glyph-orientation-vertical"],
  ["horizAdvX", "horiz-adv-x"],
  ["horizOriginX", "horiz-origin-x"],
  ["imageRendering", "image-rendering"],
  ["letterSpacing", "letter-spacing"],
  ["lightingColor", "lighting-color"],
  ["markerEnd", "marker-end"],
  ["markerMid", "marker-mid"],
  ["markerStart", "marker-start"],
  ["overlinePosition", "overline-position"],
  ["overlineThickness", "overline-thickness"],
  ["paintOrder", "paint-order"],
  ["panose-1", "panose-1"],
  ["pointerEvents", "pointer-events"],
  ["renderingIntent", "rendering-intent"],
  ["shapeRendering", "shape-rendering"],
  ["stopColor", "stop-color"],
  ["stopOpacity", "stop-opacity"],
  ["strikethroughPosition", "strikethrough-position"],
  ["strikethroughThickness", "strikethrough-thickness"],
  ["strokeDasharray", "stroke-dasharray"],
  ["strokeDashoffset", "stroke-dashoffset"],
  ["strokeLinecap", "stroke-linecap"],
  ["strokeLinejoin", "stroke-linejoin"],
  ["strokeMiterlimit", "stroke-miterlimit"],
  ["strokeOpacity", "stroke-opacity"],
  ["strokeWidth", "stroke-width"],
  ["textAnchor", "text-anchor"],
  ["textDecoration", "text-decoration"],
  ["textRendering", "text-rendering"],
  ["transformOrigin", "transform-origin"],
  ["underlinePosition", "underline-position"],
  ["underlineThickness", "underline-thickness"],
  ["unicodeBidi", "unicode-bidi"],
  ["unicodeRange", "unicode-range"],
  ["unitsPerEm", "units-per-em"],
  ["vAlphabetic", "v-alphabetic"],
  ["vHanging", "v-hanging"],
  ["vIdeographic", "v-ideographic"],
  ["vMathematical", "v-mathematical"],
  ["vectorEffect", "vector-effect"],
  ["vertAdvY", "vert-adv-y"],
  ["vertOriginX", "vert-origin-x"],
  ["vertOriginY", "vert-origin-y"],
  ["wordSpacing", "word-spacing"],
  ["writingMode", "writing-mode"],
  ["xmlnsXlink", "xmlns:xlink"],
  ["xHeight", "x-height"]
]), m0 = /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
function Wi(e) {
  return m0.test("" + e) ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')" : e;
}
function Xt() {
}
var Tr = null;
function _c(e) {
  return e = e.target || e.srcElement || window, e.correspondingUseElement && (e = e.correspondingUseElement), e.nodeType === 3 ? e.parentNode : e;
}
var Ma = null, Ga = null;
function $u(e) {
  var t = rl(e);
  if (t && (e = t.stateNode)) {
    var n = e[et] || null;
    e: switch (e = t.stateNode, t.type) {
      case "input":
        if (jr(
          e,
          n.value,
          n.defaultValue,
          n.defaultValue,
          n.checked,
          n.defaultChecked,
          n.type,
          n.name
        ), t = n.name, n.type === "radio" && t != null) {
          for (n = e; n.parentNode; ) n = n.parentNode;
          for (n = n.querySelectorAll(
            'input[name="' + vt(
              "" + t
            ) + '"][type="radio"]'
          ), t = 0; t < n.length; t++) {
            var a = n[t];
            if (a !== e && a.form === e.form) {
              var l = a[et] || null;
              if (!l) throw Error(_(90));
              jr(
                a,
                l.value,
                l.defaultValue,
                l.defaultValue,
                l.checked,
                l.defaultChecked,
                l.type,
                l.name
              );
            }
          }
          for (t = 0; t < n.length; t++)
            a = n[t], a.form === e.form && wm(a);
        }
        break e;
      case "textarea":
        Nm(e, n.value, n.defaultValue);
        break e;
      case "select":
        t = n.value, t != null && Ha(e, !!n.multiple, t, !1);
    }
  }
}
var zs = !1;
function Mm(e, t, n) {
  if (zs) return e(t, n);
  zs = !0;
  try {
    var a = e(t);
    return a;
  } finally {
    if (zs = !1, (Ma !== null || Ga !== null) && (ms(), Ma && (t = Ma, e = Ga, Ga = Ma = null, $u(t), e)))
      for (t = 0; t < e.length; t++) $u(e[t]);
  }
}
function $l(e, t) {
  var n = e.stateNode;
  if (n === null) return null;
  var a = n[et] || null;
  if (a === null) return null;
  n = a[t];
  e: switch (t) {
    case "onClick":
    case "onClickCapture":
    case "onDoubleClick":
    case "onDoubleClickCapture":
    case "onMouseDown":
    case "onMouseDownCapture":
    case "onMouseMove":
    case "onMouseMoveCapture":
    case "onMouseUp":
    case "onMouseUpCapture":
    case "onMouseEnter":
      (a = !a.disabled) || (e = e.type, a = !(e === "button" || e === "input" || e === "select" || e === "textarea")), e = !a;
      break e;
    default:
      e = !1;
  }
  if (e) return null;
  if (n && typeof n != "function")
    throw Error(
      _(231, t, typeof n)
    );
  return n;
}
var Wt = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), Dr = !1;
if (Wt)
  try {
    var Al = {};
    Object.defineProperty(Al, "passive", {
      get: function() {
        Dr = !0;
      }
    }), window.addEventListener("test", Al, Al), window.removeEventListener("test", Al, Al);
  } catch {
    Dr = !1;
  }
var Sn = null, Oc = null, $i = null;
function Tm() {
  if ($i) return $i;
  var e, t = Oc, n = t.length, a, l = "value" in Sn ? Sn.value : Sn.textContent, i = l.length;
  for (e = 0; e < n && t[e] === l[e]; e++) ;
  var o = n - e;
  for (a = 1; a <= o && t[n - a] === l[i - a]; a++) ;
  return $i = l.slice(e, 1 < a ? 1 - a : void 0);
}
function Pi(e) {
  var t = e.keyCode;
  return "charCode" in e ? (e = e.charCode, e === 0 && t === 13 && (e = 13)) : e = t, e === 10 && (e = 13), 32 <= e || e === 13 ? e : 0;
}
function ki() {
  return !0;
}
function Pu() {
  return !1;
}
function tt(e) {
  function t(n, a, l, i, o) {
    this._reactName = n, this._targetInst = l, this.type = a, this.nativeEvent = i, this.target = o, this.currentTarget = null;
    for (var s in e)
      e.hasOwnProperty(s) && (n = e[s], this[s] = n ? n(i) : i[s]);
    return this.isDefaultPrevented = (i.defaultPrevented != null ? i.defaultPrevented : i.returnValue === !1) ? ki : Pu, this.isPropagationStopped = Pu, this;
  }
  return pe(t.prototype, {
    preventDefault: function() {
      this.defaultPrevented = !0;
      var n = this.nativeEvent;
      n && (n.preventDefault ? n.preventDefault() : typeof n.returnValue != "unknown" && (n.returnValue = !1), this.isDefaultPrevented = ki);
    },
    stopPropagation: function() {
      var n = this.nativeEvent;
      n && (n.stopPropagation ? n.stopPropagation() : typeof n.cancelBubble != "unknown" && (n.cancelBubble = !0), this.isPropagationStopped = ki);
    },
    persist: function() {
    },
    isPersistent: ki
  }), t;
}
var fa = {
  eventPhase: 0,
  bubbles: 0,
  cancelable: 0,
  timeStamp: function(e) {
    return e.timeStamp || Date.now();
  },
  defaultPrevented: 0,
  isTrusted: 0
}, ns = tt(fa), pi = pe({}, fa, { view: 0, detail: 0 }), h0 = tt(pi), Rs, ks, Nl, as = pe({}, pi, {
  screenX: 0,
  screenY: 0,
  clientX: 0,
  clientY: 0,
  pageX: 0,
  pageY: 0,
  ctrlKey: 0,
  shiftKey: 0,
  altKey: 0,
  metaKey: 0,
  getModifierState: zc,
  button: 0,
  buttons: 0,
  relatedTarget: function(e) {
    return e.relatedTarget === void 0 ? e.fromElement === e.srcElement ? e.toElement : e.fromElement : e.relatedTarget;
  },
  movementX: function(e) {
    return "movementX" in e ? e.movementX : (e !== Nl && (Nl && e.type === "mousemove" ? (Rs = e.screenX - Nl.screenX, ks = e.screenY - Nl.screenY) : ks = Rs = 0, Nl = e), Rs);
  },
  movementY: function(e) {
    return "movementY" in e ? e.movementY : ks;
  }
}), ef = tt(as), g0 = pe({}, as, { dataTransfer: 0 }), v0 = tt(g0), p0 = pe({}, pi, { relatedTarget: 0 }), Us = tt(p0), y0 = pe({}, fa, {
  animationName: 0,
  elapsedTime: 0,
  pseudoElement: 0
}), b0 = tt(y0), x0 = pe({}, fa, {
  clipboardData: function(e) {
    return "clipboardData" in e ? e.clipboardData : window.clipboardData;
  }
}), S0 = tt(x0), C0 = pe({}, fa, { data: 0 }), tf = tt(C0), w0 = {
  Esc: "Escape",
  Spacebar: " ",
  Left: "ArrowLeft",
  Up: "ArrowUp",
  Right: "ArrowRight",
  Down: "ArrowDown",
  Del: "Delete",
  Win: "OS",
  Menu: "ContextMenu",
  Apps: "ContextMenu",
  Scroll: "ScrollLock",
  MozPrintableKey: "Unidentified"
}, A0 = {
  8: "Backspace",
  9: "Tab",
  12: "Clear",
  13: "Enter",
  16: "Shift",
  17: "Control",
  18: "Alt",
  19: "Pause",
  20: "CapsLock",
  27: "Escape",
  32: " ",
  33: "PageUp",
  34: "PageDown",
  35: "End",
  36: "Home",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  45: "Insert",
  46: "Delete",
  112: "F1",
  113: "F2",
  114: "F3",
  115: "F4",
  116: "F5",
  117: "F6",
  118: "F7",
  119: "F8",
  120: "F9",
  121: "F10",
  122: "F11",
  123: "F12",
  144: "NumLock",
  145: "ScrollLock",
  224: "Meta"
}, N0 = {
  Alt: "altKey",
  Control: "ctrlKey",
  Meta: "metaKey",
  Shift: "shiftKey"
};
function E0(e) {
  var t = this.nativeEvent;
  return t.getModifierState ? t.getModifierState(e) : (e = N0[e]) ? !!t[e] : !1;
}
function zc() {
  return E0;
}
var j0 = pe({}, pi, {
  key: function(e) {
    if (e.key) {
      var t = w0[e.key] || e.key;
      if (t !== "Unidentified") return t;
    }
    return e.type === "keypress" ? (e = Pi(e), e === 13 ? "Enter" : String.fromCharCode(e)) : e.type === "keydown" || e.type === "keyup" ? A0[e.keyCode] || "Unidentified" : "";
  },
  code: 0,
  location: 0,
  ctrlKey: 0,
  shiftKey: 0,
  altKey: 0,
  metaKey: 0,
  repeat: 0,
  locale: 0,
  getModifierState: zc,
  charCode: function(e) {
    return e.type === "keypress" ? Pi(e) : 0;
  },
  keyCode: function(e) {
    return e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
  },
  which: function(e) {
    return e.type === "keypress" ? Pi(e) : e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
  }
}), M0 = tt(j0), T0 = pe({}, as, {
  pointerId: 0,
  width: 0,
  height: 0,
  pressure: 0,
  tangentialPressure: 0,
  tiltX: 0,
  tiltY: 0,
  twist: 0,
  pointerType: 0,
  isPrimary: 0
}), nf = tt(T0), D0 = pe({}, pi, {
  touches: 0,
  targetTouches: 0,
  changedTouches: 0,
  altKey: 0,
  metaKey: 0,
  ctrlKey: 0,
  shiftKey: 0,
  getModifierState: zc
}), _0 = tt(D0), O0 = pe({}, fa, {
  propertyName: 0,
  elapsedTime: 0,
  pseudoElement: 0
}), z0 = tt(O0), R0 = pe({}, as, {
  deltaX: function(e) {
    return "deltaX" in e ? e.deltaX : "wheelDeltaX" in e ? -e.wheelDeltaX : 0;
  },
  deltaY: function(e) {
    return "deltaY" in e ? e.deltaY : "wheelDeltaY" in e ? -e.wheelDeltaY : "wheelDelta" in e ? -e.wheelDelta : 0;
  },
  deltaZ: 0,
  deltaMode: 0
}), k0 = tt(R0), U0 = pe({}, fa, {
  newState: 0,
  oldState: 0
}), V0 = tt(U0), L0 = [9, 13, 27, 32], Rc = Wt && "CompositionEvent" in window, Ll = null;
Wt && "documentMode" in document && (Ll = document.documentMode);
var B0 = Wt && "TextEvent" in window && !Ll, Dm = Wt && (!Rc || Ll && 8 < Ll && 11 >= Ll), af = " ", lf = !1;
function _m(e, t) {
  switch (e) {
    case "keyup":
      return L0.indexOf(t.keyCode) !== -1;
    case "keydown":
      return t.keyCode !== 229;
    case "keypress":
    case "mousedown":
    case "focusout":
      return !0;
    default:
      return !1;
  }
}
function Om(e) {
  return e = e.detail, typeof e == "object" && "data" in e ? e.data : null;
}
var Ta = !1;
function H0(e, t) {
  switch (e) {
    case "compositionend":
      return Om(t);
    case "keypress":
      return t.which !== 32 ? null : (lf = !0, af);
    case "textInput":
      return e = t.data, e === af && lf ? null : e;
    default:
      return null;
  }
}
function G0(e, t) {
  if (Ta)
    return e === "compositionend" || !Rc && _m(e, t) ? (e = Tm(), $i = Oc = Sn = null, Ta = !1, e) : null;
  switch (e) {
    case "paste":
      return null;
    case "keypress":
      if (!(t.ctrlKey || t.altKey || t.metaKey) || t.ctrlKey && t.altKey) {
        if (t.char && 1 < t.char.length)
          return t.char;
        if (t.which) return String.fromCharCode(t.which);
      }
      return null;
    case "compositionend":
      return Dm && t.locale !== "ko" ? null : t.data;
    default:
      return null;
  }
}
var Y0 = {
  color: !0,
  date: !0,
  datetime: !0,
  "datetime-local": !0,
  email: !0,
  month: !0,
  number: !0,
  password: !0,
  range: !0,
  search: !0,
  tel: !0,
  text: !0,
  time: !0,
  url: !0,
  week: !0
};
function of(e) {
  var t = e && e.nodeName && e.nodeName.toLowerCase();
  return t === "input" ? !!Y0[e.type] : t === "textarea";
}
function zm(e, t, n, a) {
  Ma ? Ga ? Ga.push(a) : Ga = [a] : Ma = a, t = ko(t, "onChange"), 0 < t.length && (n = new ns(
    "onChange",
    "change",
    null,
    n,
    a
  ), e.push({ event: n, listeners: t }));
}
var Bl = null, Pl = null;
function q0(e) {
  Mg(e, 0);
}
function ls(e) {
  var t = Rl(e);
  if (wm(t)) return e;
}
function sf(e, t) {
  if (e === "change") return t;
}
var Rm = !1;
if (Wt) {
  var Vs;
  if (Wt) {
    var Ls = "oninput" in document;
    if (!Ls) {
      var rf = document.createElement("div");
      rf.setAttribute("oninput", "return;"), Ls = typeof rf.oninput == "function";
    }
    Vs = Ls;
  } else Vs = !1;
  Rm = Vs && (!document.documentMode || 9 < document.documentMode);
}
function cf() {
  Bl && (Bl.detachEvent("onpropertychange", km), Pl = Bl = null);
}
function km(e) {
  if (e.propertyName === "value" && ls(Pl)) {
    var t = [];
    zm(
      t,
      Pl,
      e,
      _c(e)
    ), Mm(q0, t);
  }
}
function X0(e, t, n) {
  e === "focusin" ? (cf(), Bl = t, Pl = n, Bl.attachEvent("onpropertychange", km)) : e === "focusout" && cf();
}
function Q0(e) {
  if (e === "selectionchange" || e === "keyup" || e === "keydown")
    return ls(Pl);
}
function Z0(e, t) {
  if (e === "click") return ls(t);
}
function F0(e, t) {
  if (e === "input" || e === "change")
    return ls(t);
}
function K0(e, t) {
  return e === t && (e !== 0 || 1 / e === 1 / t) || e !== e && t !== t;
}
var ut = typeof Object.is == "function" ? Object.is : K0;
function ei(e, t) {
  if (ut(e, t)) return !0;
  if (typeof e != "object" || e === null || typeof t != "object" || t === null)
    return !1;
  var n = Object.keys(e), a = Object.keys(t);
  if (n.length !== a.length) return !1;
  for (a = 0; a < n.length; a++) {
    var l = n[a];
    if (!Ar.call(t, l) || !ut(e[l], t[l]))
      return !1;
  }
  return !0;
}
function uf(e) {
  for (; e && e.firstChild; ) e = e.firstChild;
  return e;
}
function ff(e, t) {
  var n = uf(e);
  e = 0;
  for (var a; n; ) {
    if (n.nodeType === 3) {
      if (a = e + n.textContent.length, e <= t && a >= t)
        return { node: n, offset: t - e };
      e = a;
    }
    e: {
      for (; n; ) {
        if (n.nextSibling) {
          n = n.nextSibling;
          break e;
        }
        n = n.parentNode;
      }
      n = void 0;
    }
    n = uf(n);
  }
}
function Um(e, t) {
  return e && t ? e === t ? !0 : e && e.nodeType === 3 ? !1 : t && t.nodeType === 3 ? Um(e, t.parentNode) : "contains" in e ? e.contains(t) : e.compareDocumentPosition ? !!(e.compareDocumentPosition(t) & 16) : !1 : !1;
}
function Vm(e) {
  e = e != null && e.ownerDocument != null && e.ownerDocument.defaultView != null ? e.ownerDocument.defaultView : window;
  for (var t = po(e.document); t instanceof e.HTMLIFrameElement; ) {
    try {
      var n = typeof t.contentWindow.location.href == "string";
    } catch {
      n = !1;
    }
    if (n) e = t.contentWindow;
    else break;
    t = po(e.document);
  }
  return t;
}
function kc(e) {
  var t = e && e.nodeName && e.nodeName.toLowerCase();
  return t && (t === "input" && (e.type === "text" || e.type === "search" || e.type === "tel" || e.type === "url" || e.type === "password") || t === "textarea" || e.contentEditable === "true");
}
var J0 = Wt && "documentMode" in document && 11 >= document.documentMode, Da = null, _r = null, Hl = null, Or = !1;
function df(e, t, n) {
  var a = n.window === n ? n.document : n.nodeType === 9 ? n : n.ownerDocument;
  Or || Da == null || Da !== po(a) || (a = Da, "selectionStart" in a && kc(a) ? a = { start: a.selectionStart, end: a.selectionEnd } : (a = (a.ownerDocument && a.ownerDocument.defaultView || window).getSelection(), a = {
    anchorNode: a.anchorNode,
    anchorOffset: a.anchorOffset,
    focusNode: a.focusNode,
    focusOffset: a.focusOffset
  }), Hl && ei(Hl, a) || (Hl = a, a = ko(_r, "onSelect"), 0 < a.length && (t = new ns(
    "onSelect",
    "select",
    null,
    t,
    n
  ), e.push({ event: t, listeners: a }), t.target = Da)));
}
function Zn(e, t) {
  var n = {};
  return n[e.toLowerCase()] = t.toLowerCase(), n["Webkit" + e] = "webkit" + t, n["Moz" + e] = "moz" + t, n;
}
var _a = {
  animationend: Zn("Animation", "AnimationEnd"),
  animationiteration: Zn("Animation", "AnimationIteration"),
  animationstart: Zn("Animation", "AnimationStart"),
  transitionrun: Zn("Transition", "TransitionRun"),
  transitionstart: Zn("Transition", "TransitionStart"),
  transitioncancel: Zn("Transition", "TransitionCancel"),
  transitionend: Zn("Transition", "TransitionEnd")
}, Bs = {}, Lm = {};
Wt && (Lm = document.createElement("div").style, "AnimationEvent" in window || (delete _a.animationend.animation, delete _a.animationiteration.animation, delete _a.animationstart.animation), "TransitionEvent" in window || delete _a.transitionend.transition);
function da(e) {
  if (Bs[e]) return Bs[e];
  if (!_a[e]) return e;
  var t = _a[e], n;
  for (n in t)
    if (t.hasOwnProperty(n) && n in Lm)
      return Bs[e] = t[n];
  return e;
}
var Bm = da("animationend"), Hm = da("animationiteration"), Gm = da("animationstart"), I0 = da("transitionrun"), W0 = da("transitionstart"), $0 = da("transitioncancel"), Ym = da("transitionend"), qm = /* @__PURE__ */ new Map(), zr = "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
  " "
);
zr.push("scrollEnd");
function Nt(e, t) {
  qm.set(e, t), ua(t, [e]);
}
var yo = typeof reportError == "function" ? reportError : function(e) {
  if (typeof window == "object" && typeof window.ErrorEvent == "function") {
    var t = new window.ErrorEvent("error", {
      bubbles: !0,
      cancelable: !0,
      message: typeof e == "object" && e !== null && typeof e.message == "string" ? String(e.message) : String(e),
      error: e
    });
    if (!window.dispatchEvent(t)) return;
  } else if (typeof process == "object" && typeof process.emit == "function") {
    process.emit("uncaughtException", e);
    return;
  }
  console.error(e);
}, dt = [], Oa = 0, Uc = 0;
function is() {
  for (var e = Oa, t = Uc = Oa = 0; t < e; ) {
    var n = dt[t];
    dt[t++] = null;
    var a = dt[t];
    dt[t++] = null;
    var l = dt[t];
    dt[t++] = null;
    var i = dt[t];
    if (dt[t++] = null, a !== null && l !== null) {
      var o = a.pending;
      o === null ? l.next = l : (l.next = o.next, o.next = l), a.pending = l;
    }
    i !== 0 && Xm(n, l, i);
  }
}
function os(e, t, n, a) {
  dt[Oa++] = e, dt[Oa++] = t, dt[Oa++] = n, dt[Oa++] = a, Uc |= a, e.lanes |= a, e = e.alternate, e !== null && (e.lanes |= a);
}
function Vc(e, t, n, a) {
  return os(e, t, n, a), bo(e);
}
function ma(e, t) {
  return os(e, null, null, t), bo(e);
}
function Xm(e, t, n) {
  e.lanes |= n;
  var a = e.alternate;
  a !== null && (a.lanes |= n);
  for (var l = !1, i = e.return; i !== null; )
    i.childLanes |= n, a = i.alternate, a !== null && (a.childLanes |= n), i.tag === 22 && (e = i.stateNode, e === null || e._visibility & 1 || (l = !0)), e = i, i = i.return;
  return e.tag === 3 ? (i = e.stateNode, l && t !== null && (l = 31 - rt(n), e = i.hiddenUpdates, a = e[l], a === null ? e[l] = [t] : a.push(t), t.lane = n | 536870912), i) : null;
}
function bo(e) {
  if (50 < Jl)
    throw Jl = 0, ec = null, Error(_(185));
  for (var t = e.return; t !== null; )
    e = t, t = e.return;
  return e.tag === 3 ? e.stateNode : null;
}
var za = {};
function P0(e, t, n, a) {
  this.tag = e, this.key = n, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.refCleanup = this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = a, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
}
function lt(e, t, n, a) {
  return new P0(e, t, n, a);
}
function Lc(e) {
  return e = e.prototype, !(!e || !e.isReactComponent);
}
function Zt(e, t) {
  var n = e.alternate;
  return n === null ? (n = lt(
    e.tag,
    t,
    e.key,
    e.mode
  ), n.elementType = e.elementType, n.type = e.type, n.stateNode = e.stateNode, n.alternate = e, e.alternate = n) : (n.pendingProps = t, n.type = e.type, n.flags = 0, n.subtreeFlags = 0, n.deletions = null), n.flags = e.flags & 65011712, n.childLanes = e.childLanes, n.lanes = e.lanes, n.child = e.child, n.memoizedProps = e.memoizedProps, n.memoizedState = e.memoizedState, n.updateQueue = e.updateQueue, t = e.dependencies, n.dependencies = t === null ? null : { lanes: t.lanes, firstContext: t.firstContext }, n.sibling = e.sibling, n.index = e.index, n.ref = e.ref, n.refCleanup = e.refCleanup, n;
}
function Qm(e, t) {
  e.flags &= 65011714;
  var n = e.alternate;
  return n === null ? (e.childLanes = 0, e.lanes = t, e.child = null, e.subtreeFlags = 0, e.memoizedProps = null, e.memoizedState = null, e.updateQueue = null, e.dependencies = null, e.stateNode = null) : (e.childLanes = n.childLanes, e.lanes = n.lanes, e.child = n.child, e.subtreeFlags = 0, e.deletions = null, e.memoizedProps = n.memoizedProps, e.memoizedState = n.memoizedState, e.updateQueue = n.updateQueue, e.type = n.type, t = n.dependencies, e.dependencies = t === null ? null : {
    lanes: t.lanes,
    firstContext: t.firstContext
  }), e;
}
function eo(e, t, n, a, l, i) {
  var o = 0;
  if (a = e, typeof e == "function") Lc(e) && (o = 1);
  else if (typeof e == "string")
    o = l1(
      e,
      n,
      Dt.current
    ) ? 26 : e === "html" || e === "head" || e === "body" ? 27 : 5;
  else
    e: switch (e) {
      case xr:
        return e = lt(31, n, t, l), e.elementType = xr, e.lanes = i, e;
      case Na:
        return ea(n.children, l, i, t);
      case um:
        o = 8, l |= 24;
        break;
      case pr:
        return e = lt(12, n, t, l | 2), e.elementType = pr, e.lanes = i, e;
      case yr:
        return e = lt(13, n, t, l), e.elementType = yr, e.lanes = i, e;
      case br:
        return e = lt(19, n, t, l), e.elementType = br, e.lanes = i, e;
      default:
        if (typeof e == "object" && e !== null)
          switch (e.$$typeof) {
            case qt:
              o = 10;
              break e;
            case fm:
              o = 9;
              break e;
            case Ac:
              o = 11;
              break e;
            case Nc:
              o = 14;
              break e;
            case mn:
              o = 16, a = null;
              break e;
          }
        o = 29, n = Error(
          _(130, e === null ? "null" : typeof e, "")
        ), a = null;
    }
  return t = lt(o, n, t, l), t.elementType = e, t.type = a, t.lanes = i, t;
}
function ea(e, t, n, a) {
  return e = lt(7, e, a, t), e.lanes = n, e;
}
function Hs(e, t, n) {
  return e = lt(6, e, null, t), e.lanes = n, e;
}
function Zm(e) {
  var t = lt(18, null, null, 0);
  return t.stateNode = e, t;
}
function Gs(e, t, n) {
  return t = lt(
    4,
    e.children !== null ? e.children : [],
    e.key,
    t
  ), t.lanes = n, t.stateNode = {
    containerInfo: e.containerInfo,
    pendingChildren: null,
    implementation: e.implementation
  }, t;
}
var mf = /* @__PURE__ */ new WeakMap();
function pt(e, t) {
  if (typeof e == "object" && e !== null) {
    var n = mf.get(e);
    return n !== void 0 ? n : (t = {
      value: e,
      source: t,
      stack: Zu(t)
    }, mf.set(e, t), t);
  }
  return {
    value: e,
    source: t,
    stack: Zu(t)
  };
}
var Ra = [], ka = 0, xo = null, ti = 0, ht = [], gt = 0, Un = null, jt = 1, Mt = "";
function Gt(e, t) {
  Ra[ka++] = ti, Ra[ka++] = xo, xo = e, ti = t;
}
function Fm(e, t, n) {
  ht[gt++] = jt, ht[gt++] = Mt, ht[gt++] = Un, Un = e;
  var a = jt;
  e = Mt;
  var l = 32 - rt(a) - 1;
  a &= ~(1 << l), n += 1;
  var i = 32 - rt(t) + l;
  if (30 < i) {
    var o = l - l % 5;
    i = (a & (1 << o) - 1).toString(32), a >>= o, l -= o, jt = 1 << 32 - rt(t) + l | n << l | a, Mt = i + e;
  } else
    jt = 1 << i | n << l | a, Mt = e;
}
function Bc(e) {
  e.return !== null && (Gt(e, 1), Fm(e, 1, 0));
}
function Hc(e) {
  for (; e === xo; )
    xo = Ra[--ka], Ra[ka] = null, ti = Ra[--ka], Ra[ka] = null;
  for (; e === Un; )
    Un = ht[--gt], ht[gt] = null, Mt = ht[--gt], ht[gt] = null, jt = ht[--gt], ht[gt] = null;
}
function Km(e, t) {
  ht[gt++] = jt, ht[gt++] = Mt, ht[gt++] = Un, jt = t.id, Mt = t.overflow, Un = e;
}
var Ye = null, ge = null, ee = !1, jn = null, yt = !1, Rr = Error(_(519));
function Vn(e) {
  var t = Error(
    _(
      418,
      1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML",
      ""
    )
  );
  throw ni(pt(t, e)), Rr;
}
function hf(e) {
  var t = e.stateNode, n = e.type, a = e.memoizedProps;
  switch (t[Ge] = e, t[et] = a, n) {
    case "dialog":
      W("cancel", t), W("close", t);
      break;
    case "iframe":
    case "object":
    case "embed":
      W("load", t);
      break;
    case "video":
    case "audio":
      for (n = 0; n < oi.length; n++)
        W(oi[n], t);
      break;
    case "source":
      W("error", t);
      break;
    case "img":
    case "image":
    case "link":
      W("error", t), W("load", t);
      break;
    case "details":
      W("toggle", t);
      break;
    case "input":
      W("invalid", t), Am(
        t,
        a.value,
        a.defaultValue,
        a.checked,
        a.defaultChecked,
        a.type,
        a.name,
        !0
      );
      break;
    case "select":
      W("invalid", t);
      break;
    case "textarea":
      W("invalid", t), Em(t, a.value, a.defaultValue, a.children);
  }
  n = a.children, typeof n != "string" && typeof n != "number" && typeof n != "bigint" || t.textContent === "" + n || a.suppressHydrationWarning === !0 || Dg(t.textContent, n) ? (a.popover != null && (W("beforetoggle", t), W("toggle", t)), a.onScroll != null && W("scroll", t), a.onScrollEnd != null && W("scrollend", t), a.onClick != null && (t.onclick = Xt), t = !0) : t = !1, t || Vn(e, !0);
}
function gf(e) {
  for (Ye = e.return; Ye; )
    switch (Ye.tag) {
      case 5:
      case 31:
      case 13:
        yt = !1;
        return;
      case 27:
      case 3:
        yt = !0;
        return;
      default:
        Ye = Ye.return;
    }
}
function pa(e) {
  if (e !== Ye) return !1;
  if (!ee) return gf(e), ee = !0, !1;
  var t = e.tag, n;
  if ((n = t !== 3 && t !== 27) && ((n = t === 5) && (n = e.type, n = !(n !== "form" && n !== "button") || ic(e.type, e.memoizedProps)), n = !n), n && ge && Vn(e), gf(e), t === 13) {
    if (e = e.memoizedState, e = e !== null ? e.dehydrated : null, !e) throw Error(_(317));
    ge = td(e);
  } else if (t === 31) {
    if (e = e.memoizedState, e = e !== null ? e.dehydrated : null, !e) throw Error(_(317));
    ge = td(e);
  } else
    t === 27 ? (t = ge, Yn(e.type) ? (e = cc, cc = null, ge = e) : ge = t) : ge = Ye ? xt(e.stateNode.nextSibling) : null;
  return !0;
}
function la() {
  ge = Ye = null, ee = !1;
}
function Ys() {
  var e = jn;
  return e !== null && ($e === null ? $e = e : $e.push.apply(
    $e,
    e
  ), jn = null), e;
}
function ni(e) {
  jn === null ? jn = [e] : jn.push(e);
}
var kr = _t(null), ha = null, Qt = null;
function gn(e, t, n) {
  de(kr, t._currentValue), t._currentValue = n;
}
function Ft(e) {
  e._currentValue = kr.current, Le(kr);
}
function Ur(e, t, n) {
  for (; e !== null; ) {
    var a = e.alternate;
    if ((e.childLanes & t) !== t ? (e.childLanes |= t, a !== null && (a.childLanes |= t)) : a !== null && (a.childLanes & t) !== t && (a.childLanes |= t), e === n) break;
    e = e.return;
  }
}
function Vr(e, t, n, a) {
  var l = e.child;
  for (l !== null && (l.return = e); l !== null; ) {
    var i = l.dependencies;
    if (i !== null) {
      var o = l.child;
      i = i.firstContext;
      e: for (; i !== null; ) {
        var s = i;
        i = l;
        for (var c = 0; c < t.length; c++)
          if (s.context === t[c]) {
            i.lanes |= n, s = i.alternate, s !== null && (s.lanes |= n), Ur(
              i.return,
              n,
              e
            ), a || (o = null);
            break e;
          }
        i = s.next;
      }
    } else if (l.tag === 18) {
      if (o = l.return, o === null) throw Error(_(341));
      o.lanes |= n, i = o.alternate, i !== null && (i.lanes |= n), Ur(o, n, e), o = null;
    } else o = l.child;
    if (o !== null) o.return = l;
    else
      for (o = l; o !== null; ) {
        if (o === e) {
          o = null;
          break;
        }
        if (l = o.sibling, l !== null) {
          l.return = o.return, o = l;
          break;
        }
        o = o.return;
      }
    l = o;
  }
}
function cl(e, t, n, a) {
  e = null;
  for (var l = t, i = !1; l !== null; ) {
    if (!i) {
      if (l.flags & 524288) i = !0;
      else if (l.flags & 262144) break;
    }
    if (l.tag === 10) {
      var o = l.alternate;
      if (o === null) throw Error(_(387));
      if (o = o.memoizedProps, o !== null) {
        var s = l.type;
        ut(l.pendingProps.value, o.value) || (e !== null ? e.push(s) : e = [s]);
      }
    } else if (l === mo.current) {
      if (o = l.alternate, o === null) throw Error(_(387));
      o.memoizedState.memoizedState !== l.memoizedState.memoizedState && (e !== null ? e.push(ri) : e = [ri]);
    }
    l = l.return;
  }
  e !== null && Vr(
    t,
    e,
    n,
    a
  ), t.flags |= 262144;
}
function So(e) {
  for (e = e.firstContext; e !== null; ) {
    if (!ut(
      e.context._currentValue,
      e.memoizedValue
    ))
      return !0;
    e = e.next;
  }
  return !1;
}
function ia(e) {
  ha = e, Qt = null, e = e.dependencies, e !== null && (e.firstContext = null);
}
function qe(e) {
  return Jm(ha, e);
}
function Ui(e, t) {
  return ha === null && ia(e), Jm(e, t);
}
function Jm(e, t) {
  var n = t._currentValue;
  if (t = { context: t, memoizedValue: n, next: null }, Qt === null) {
    if (e === null) throw Error(_(308));
    Qt = t, e.dependencies = { lanes: 0, firstContext: t }, e.flags |= 524288;
  } else Qt = Qt.next = t;
  return n;
}
var eb = typeof AbortController < "u" ? AbortController : function() {
  var e = [], t = this.signal = {
    aborted: !1,
    addEventListener: function(n, a) {
      e.push(a);
    }
  };
  this.abort = function() {
    t.aborted = !0, e.forEach(function(n) {
      return n();
    });
  };
}, tb = Re.unstable_scheduleCallback, nb = Re.unstable_NormalPriority, Te = {
  $$typeof: qt,
  Consumer: null,
  Provider: null,
  _currentValue: null,
  _currentValue2: null,
  _threadCount: 0
};
function Gc() {
  return {
    controller: new eb(),
    data: /* @__PURE__ */ new Map(),
    refCount: 0
  };
}
function yi(e) {
  e.refCount--, e.refCount === 0 && tb(nb, function() {
    e.controller.abort();
  });
}
var Gl = null, Lr = 0, Ia = 0, Ya = null;
function ab(e, t) {
  if (Gl === null) {
    var n = Gl = [];
    Lr = 0, Ia = du(), Ya = {
      status: "pending",
      value: void 0,
      then: function(a) {
        n.push(a);
      }
    };
  }
  return Lr++, t.then(vf, vf), t;
}
function vf() {
  if (--Lr === 0 && Gl !== null) {
    Ya !== null && (Ya.status = "fulfilled");
    var e = Gl;
    Gl = null, Ia = 0, Ya = null;
    for (var t = 0; t < e.length; t++) (0, e[t])();
  }
}
function lb(e, t) {
  var n = [], a = {
    status: "pending",
    value: null,
    reason: null,
    then: function(l) {
      n.push(l);
    }
  };
  return e.then(
    function() {
      a.status = "fulfilled", a.value = t;
      for (var l = 0; l < n.length; l++) (0, n[l])(t);
    },
    function(l) {
      for (a.status = "rejected", a.reason = l, l = 0; l < n.length; l++)
        (0, n[l])(void 0);
    }
  ), a;
}
var pf = G.S;
G.S = function(e, t) {
  cg = ot(), typeof t == "object" && t !== null && typeof t.then == "function" && ab(e, t), pf !== null && pf(e, t);
};
var ta = _t(null);
function Yc() {
  var e = ta.current;
  return e !== null ? e : fe.pooledCache;
}
function to(e, t) {
  t === null ? de(ta, ta.current) : de(ta, t.pool);
}
function Im() {
  var e = Yc();
  return e === null ? null : { parent: Te._currentValue, pool: e };
}
var ul = Error(_(460)), qc = Error(_(474)), ss = Error(_(542)), Co = { then: function() {
} };
function yf(e) {
  return e = e.status, e === "fulfilled" || e === "rejected";
}
function Wm(e, t, n) {
  switch (n = e[n], n === void 0 ? e.push(t) : n !== t && (t.then(Xt, Xt), t = n), t.status) {
    case "fulfilled":
      return t.value;
    case "rejected":
      throw e = t.reason, xf(e), e;
    default:
      if (typeof t.status == "string") t.then(Xt, Xt);
      else {
        if (e = fe, e !== null && 100 < e.shellSuspendCounter)
          throw Error(_(482));
        e = t, e.status = "pending", e.then(
          function(a) {
            if (t.status === "pending") {
              var l = t;
              l.status = "fulfilled", l.value = a;
            }
          },
          function(a) {
            if (t.status === "pending") {
              var l = t;
              l.status = "rejected", l.reason = a;
            }
          }
        );
      }
      switch (t.status) {
        case "fulfilled":
          return t.value;
        case "rejected":
          throw e = t.reason, xf(e), e;
      }
      throw na = t, ul;
  }
}
function In(e) {
  try {
    var t = e._init;
    return t(e._payload);
  } catch (n) {
    throw n !== null && typeof n == "object" && typeof n.then == "function" ? (na = n, ul) : n;
  }
}
var na = null;
function bf() {
  if (na === null) throw Error(_(459));
  var e = na;
  return na = null, e;
}
function xf(e) {
  if (e === ul || e === ss)
    throw Error(_(483));
}
var qa = null, ai = 0;
function Vi(e) {
  var t = ai;
  return ai += 1, qa === null && (qa = []), Wm(qa, e, t);
}
function El(e, t) {
  t = t.props.ref, e.ref = t !== void 0 ? t : null;
}
function Li(e, t) {
  throw t.$$typeof === Xy ? Error(_(525)) : (e = Object.prototype.toString.call(t), Error(
    _(
      31,
      e === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : e
    )
  ));
}
function $m(e) {
  function t(h, d) {
    if (e) {
      var y = h.deletions;
      y === null ? (h.deletions = [d], h.flags |= 16) : y.push(d);
    }
  }
  function n(h, d) {
    if (!e) return null;
    for (; d !== null; )
      t(h, d), d = d.sibling;
    return null;
  }
  function a(h) {
    for (var d = /* @__PURE__ */ new Map(); h !== null; )
      h.key !== null ? d.set(h.key, h) : d.set(h.index, h), h = h.sibling;
    return d;
  }
  function l(h, d) {
    return h = Zt(h, d), h.index = 0, h.sibling = null, h;
  }
  function i(h, d, y) {
    return h.index = y, e ? (y = h.alternate, y !== null ? (y = y.index, y < d ? (h.flags |= 67108866, d) : y) : (h.flags |= 67108866, d)) : (h.flags |= 1048576, d);
  }
  function o(h) {
    return e && h.alternate === null && (h.flags |= 67108866), h;
  }
  function s(h, d, y, b) {
    return d === null || d.tag !== 6 ? (d = Hs(y, h.mode, b), d.return = h, d) : (d = l(d, y), d.return = h, d);
  }
  function c(h, d, y, b) {
    var N = y.type;
    return N === Na ? m(
      h,
      d,
      y.props.children,
      b,
      y.key
    ) : d !== null && (d.elementType === N || typeof N == "object" && N !== null && N.$$typeof === mn && In(N) === d.type) ? (d = l(d, y.props), El(d, y), d.return = h, d) : (d = eo(
      y.type,
      y.key,
      y.props,
      null,
      h.mode,
      b
    ), El(d, y), d.return = h, d);
  }
  function u(h, d, y, b) {
    return d === null || d.tag !== 4 || d.stateNode.containerInfo !== y.containerInfo || d.stateNode.implementation !== y.implementation ? (d = Gs(y, h.mode, b), d.return = h, d) : (d = l(d, y.children || []), d.return = h, d);
  }
  function m(h, d, y, b, N) {
    return d === null || d.tag !== 7 ? (d = ea(
      y,
      h.mode,
      b,
      N
    ), d.return = h, d) : (d = l(d, y), d.return = h, d);
  }
  function g(h, d, y) {
    if (typeof d == "string" && d !== "" || typeof d == "number" || typeof d == "bigint")
      return d = Hs(
        "" + d,
        h.mode,
        y
      ), d.return = h, d;
    if (typeof d == "object" && d !== null) {
      switch (d.$$typeof) {
        case Di:
          return y = eo(
            d.type,
            d.key,
            d.props,
            null,
            h.mode,
            y
          ), El(y, d), y.return = h, y;
        case Ol:
          return d = Gs(
            d,
            h.mode,
            y
          ), d.return = h, d;
        case mn:
          return d = In(d), g(h, d, y);
      }
      if (zl(d) || wl(d))
        return d = ea(
          d,
          h.mode,
          y,
          null
        ), d.return = h, d;
      if (typeof d.then == "function")
        return g(h, Vi(d), y);
      if (d.$$typeof === qt)
        return g(
          h,
          Ui(h, d),
          y
        );
      Li(h, d);
    }
    return null;
  }
  function f(h, d, y, b) {
    var N = d !== null ? d.key : null;
    if (typeof y == "string" && y !== "" || typeof y == "number" || typeof y == "bigint")
      return N !== null ? null : s(h, d, "" + y, b);
    if (typeof y == "object" && y !== null) {
      switch (y.$$typeof) {
        case Di:
          return y.key === N ? c(h, d, y, b) : null;
        case Ol:
          return y.key === N ? u(h, d, y, b) : null;
        case mn:
          return y = In(y), f(h, d, y, b);
      }
      if (zl(y) || wl(y))
        return N !== null ? null : m(h, d, y, b, null);
      if (typeof y.then == "function")
        return f(
          h,
          d,
          Vi(y),
          b
        );
      if (y.$$typeof === qt)
        return f(
          h,
          d,
          Ui(h, y),
          b
        );
      Li(h, y);
    }
    return null;
  }
  function p(h, d, y, b, N) {
    if (typeof b == "string" && b !== "" || typeof b == "number" || typeof b == "bigint")
      return h = h.get(y) || null, s(d, h, "" + b, N);
    if (typeof b == "object" && b !== null) {
      switch (b.$$typeof) {
        case Di:
          return h = h.get(
            b.key === null ? y : b.key
          ) || null, c(d, h, b, N);
        case Ol:
          return h = h.get(
            b.key === null ? y : b.key
          ) || null, u(d, h, b, N);
        case mn:
          return b = In(b), p(
            h,
            d,
            y,
            b,
            N
          );
      }
      if (zl(b) || wl(b))
        return h = h.get(y) || null, m(d, h, b, N, null);
      if (typeof b.then == "function")
        return p(
          h,
          d,
          y,
          Vi(b),
          N
        );
      if (b.$$typeof === qt)
        return p(
          h,
          d,
          y,
          Ui(d, b),
          N
        );
      Li(d, b);
    }
    return null;
  }
  function C(h, d, y, b) {
    for (var N = null, O = null, M = d, A = d = 0, w = null; M !== null && A < y.length; A++) {
      M.index > A ? (w = M, M = null) : w = M.sibling;
      var E = f(
        h,
        M,
        y[A],
        b
      );
      if (E === null) {
        M === null && (M = w);
        break;
      }
      e && M && E.alternate === null && t(h, M), d = i(E, d, A), O === null ? N = E : O.sibling = E, O = E, M = w;
    }
    if (A === y.length)
      return n(h, M), ee && Gt(h, A), N;
    if (M === null) {
      for (; A < y.length; A++)
        M = g(h, y[A], b), M !== null && (d = i(
          M,
          d,
          A
        ), O === null ? N = M : O.sibling = M, O = M);
      return ee && Gt(h, A), N;
    }
    for (M = a(M); A < y.length; A++)
      w = p(
        M,
        h,
        A,
        y[A],
        b
      ), w !== null && (e && w.alternate !== null && M.delete(
        w.key === null ? A : w.key
      ), d = i(
        w,
        d,
        A
      ), O === null ? N = w : O.sibling = w, O = w);
    return e && M.forEach(function(R) {
      return t(h, R);
    }), ee && Gt(h, A), N;
  }
  function x(h, d, y, b) {
    if (y == null) throw Error(_(151));
    for (var N = null, O = null, M = d, A = d = 0, w = null, E = y.next(); M !== null && !E.done; A++, E = y.next()) {
      M.index > A ? (w = M, M = null) : w = M.sibling;
      var R = f(h, M, E.value, b);
      if (R === null) {
        M === null && (M = w);
        break;
      }
      e && M && R.alternate === null && t(h, M), d = i(R, d, A), O === null ? N = R : O.sibling = R, O = R, M = w;
    }
    if (E.done)
      return n(h, M), ee && Gt(h, A), N;
    if (M === null) {
      for (; !E.done; A++, E = y.next())
        E = g(h, E.value, b), E !== null && (d = i(E, d, A), O === null ? N = E : O.sibling = E, O = E);
      return ee && Gt(h, A), N;
    }
    for (M = a(M); !E.done; A++, E = y.next())
      E = p(M, h, A, E.value, b), E !== null && (e && E.alternate !== null && M.delete(E.key === null ? A : E.key), d = i(E, d, A), O === null ? N = E : O.sibling = E, O = E);
    return e && M.forEach(function(k) {
      return t(h, k);
    }), ee && Gt(h, A), N;
  }
  function S(h, d, y, b) {
    if (typeof y == "object" && y !== null && y.type === Na && y.key === null && (y = y.props.children), typeof y == "object" && y !== null) {
      switch (y.$$typeof) {
        case Di:
          e: {
            for (var N = y.key; d !== null; ) {
              if (d.key === N) {
                if (N = y.type, N === Na) {
                  if (d.tag === 7) {
                    n(
                      h,
                      d.sibling
                    ), b = l(
                      d,
                      y.props.children
                    ), b.return = h, h = b;
                    break e;
                  }
                } else if (d.elementType === N || typeof N == "object" && N !== null && N.$$typeof === mn && In(N) === d.type) {
                  n(
                    h,
                    d.sibling
                  ), b = l(d, y.props), El(b, y), b.return = h, h = b;
                  break e;
                }
                n(h, d);
                break;
              } else t(h, d);
              d = d.sibling;
            }
            y.type === Na ? (b = ea(
              y.props.children,
              h.mode,
              b,
              y.key
            ), b.return = h, h = b) : (b = eo(
              y.type,
              y.key,
              y.props,
              null,
              h.mode,
              b
            ), El(b, y), b.return = h, h = b);
          }
          return o(h);
        case Ol:
          e: {
            for (N = y.key; d !== null; ) {
              if (d.key === N)
                if (d.tag === 4 && d.stateNode.containerInfo === y.containerInfo && d.stateNode.implementation === y.implementation) {
                  n(
                    h,
                    d.sibling
                  ), b = l(d, y.children || []), b.return = h, h = b;
                  break e;
                } else {
                  n(h, d);
                  break;
                }
              else t(h, d);
              d = d.sibling;
            }
            b = Gs(y, h.mode, b), b.return = h, h = b;
          }
          return o(h);
        case mn:
          return y = In(y), S(
            h,
            d,
            y,
            b
          );
      }
      if (zl(y))
        return C(
          h,
          d,
          y,
          b
        );
      if (wl(y)) {
        if (N = wl(y), typeof N != "function") throw Error(_(150));
        return y = N.call(y), x(
          h,
          d,
          y,
          b
        );
      }
      if (typeof y.then == "function")
        return S(
          h,
          d,
          Vi(y),
          b
        );
      if (y.$$typeof === qt)
        return S(
          h,
          d,
          Ui(h, y),
          b
        );
      Li(h, y);
    }
    return typeof y == "string" && y !== "" || typeof y == "number" || typeof y == "bigint" ? (y = "" + y, d !== null && d.tag === 6 ? (n(h, d.sibling), b = l(d, y), b.return = h, h = b) : (n(h, d), b = Hs(y, h.mode, b), b.return = h, h = b), o(h)) : n(h, d);
  }
  return function(h, d, y, b) {
    try {
      ai = 0;
      var N = S(
        h,
        d,
        y,
        b
      );
      return qa = null, N;
    } catch (M) {
      if (M === ul || M === ss) throw M;
      var O = lt(29, M, null, h.mode);
      return O.lanes = b, O.return = h, O;
    } finally {
    }
  };
}
var oa = $m(!0), Pm = $m(!1), hn = !1;
function Xc(e) {
  e.updateQueue = {
    baseState: e.memoizedState,
    firstBaseUpdate: null,
    lastBaseUpdate: null,
    shared: { pending: null, lanes: 0, hiddenCallbacks: null },
    callbacks: null
  };
}
function Br(e, t) {
  e = e.updateQueue, t.updateQueue === e && (t.updateQueue = {
    baseState: e.baseState,
    firstBaseUpdate: e.firstBaseUpdate,
    lastBaseUpdate: e.lastBaseUpdate,
    shared: e.shared,
    callbacks: null
  });
}
function Mn(e) {
  return { lane: e, tag: 0, payload: null, callback: null, next: null };
}
function Tn(e, t, n) {
  var a = e.updateQueue;
  if (a === null) return null;
  if (a = a.shared, ae & 2) {
    var l = a.pending;
    return l === null ? t.next = t : (t.next = l.next, l.next = t), a.pending = t, t = bo(e), Xm(e, null, n), t;
  }
  return os(e, a, t, n), bo(e);
}
function Yl(e, t, n) {
  if (t = t.updateQueue, t !== null && (t = t.shared, (n & 4194048) !== 0)) {
    var a = t.lanes;
    a &= e.pendingLanes, n |= a, t.lanes = n, pm(e, n);
  }
}
function qs(e, t) {
  var n = e.updateQueue, a = e.alternate;
  if (a !== null && (a = a.updateQueue, n === a)) {
    var l = null, i = null;
    if (n = n.firstBaseUpdate, n !== null) {
      do {
        var o = {
          lane: n.lane,
          tag: n.tag,
          payload: n.payload,
          callback: null,
          next: null
        };
        i === null ? l = i = o : i = i.next = o, n = n.next;
      } while (n !== null);
      i === null ? l = i = t : i = i.next = t;
    } else l = i = t;
    n = {
      baseState: a.baseState,
      firstBaseUpdate: l,
      lastBaseUpdate: i,
      shared: a.shared,
      callbacks: a.callbacks
    }, e.updateQueue = n;
    return;
  }
  e = n.lastBaseUpdate, e === null ? n.firstBaseUpdate = t : e.next = t, n.lastBaseUpdate = t;
}
var Hr = !1;
function ql() {
  if (Hr) {
    var e = Ya;
    if (e !== null) throw e;
  }
}
function Xl(e, t, n, a) {
  Hr = !1;
  var l = e.updateQueue;
  hn = !1;
  var i = l.firstBaseUpdate, o = l.lastBaseUpdate, s = l.shared.pending;
  if (s !== null) {
    l.shared.pending = null;
    var c = s, u = c.next;
    c.next = null, o === null ? i = u : o.next = u, o = c;
    var m = e.alternate;
    m !== null && (m = m.updateQueue, s = m.lastBaseUpdate, s !== o && (s === null ? m.firstBaseUpdate = u : s.next = u, m.lastBaseUpdate = c));
  }
  if (i !== null) {
    var g = l.baseState;
    o = 0, m = u = c = null, s = i;
    do {
      var f = s.lane & -536870913, p = f !== s.lane;
      if (p ? (P & f) === f : (a & f) === f) {
        f !== 0 && f === Ia && (Hr = !0), m !== null && (m = m.next = {
          lane: 0,
          tag: s.tag,
          payload: s.payload,
          callback: null,
          next: null
        });
        e: {
          var C = e, x = s;
          f = t;
          var S = n;
          switch (x.tag) {
            case 1:
              if (C = x.payload, typeof C == "function") {
                g = C.call(S, g, f);
                break e;
              }
              g = C;
              break e;
            case 3:
              C.flags = C.flags & -65537 | 128;
            case 0:
              if (C = x.payload, f = typeof C == "function" ? C.call(S, g, f) : C, f == null) break e;
              g = pe({}, g, f);
              break e;
            case 2:
              hn = !0;
          }
        }
        f = s.callback, f !== null && (e.flags |= 64, p && (e.flags |= 8192), p = l.callbacks, p === null ? l.callbacks = [f] : p.push(f));
      } else
        p = {
          lane: f,
          tag: s.tag,
          payload: s.payload,
          callback: s.callback,
          next: null
        }, m === null ? (u = m = p, c = g) : m = m.next = p, o |= f;
      if (s = s.next, s === null) {
        if (s = l.shared.pending, s === null)
          break;
        p = s, s = p.next, p.next = null, l.lastBaseUpdate = p, l.shared.pending = null;
      }
    } while (!0);
    m === null && (c = g), l.baseState = c, l.firstBaseUpdate = u, l.lastBaseUpdate = m, i === null && (l.shared.lanes = 0), Bn |= o, e.lanes = o, e.memoizedState = g;
  }
}
function eh(e, t) {
  if (typeof e != "function")
    throw Error(_(191, e));
  e.call(t);
}
function th(e, t) {
  var n = e.callbacks;
  if (n !== null)
    for (e.callbacks = null, e = 0; e < n.length; e++)
      eh(n[e], t);
}
var Wa = _t(null), wo = _t(0);
function Sf(e, t) {
  e = tn, de(wo, e), de(Wa, t), tn = e | t.baseLanes;
}
function Gr() {
  de(wo, tn), de(Wa, Wa.current);
}
function Qc() {
  tn = wo.current, Le(Wa), Le(wo);
}
var ft = _t(null), bt = null;
function vn(e) {
  var t = e.alternate;
  de(Ae, Ae.current & 1), de(ft, e), bt === null && (t === null || Wa.current !== null || t.memoizedState !== null) && (bt = e);
}
function Yr(e) {
  de(Ae, Ae.current), de(ft, e), bt === null && (bt = e);
}
function nh(e) {
  e.tag === 22 ? (de(Ae, Ae.current), de(ft, e), bt === null && (bt = e)) : pn();
}
function pn() {
  de(Ae, Ae.current), de(ft, ft.current);
}
function at(e) {
  Le(ft), bt === e && (bt = null), Le(Ae);
}
var Ae = _t(0);
function Ao(e) {
  for (var t = e; t !== null; ) {
    if (t.tag === 13) {
      var n = t.memoizedState;
      if (n !== null && (n = n.dehydrated, n === null || sc(n) || rc(n)))
        return t;
    } else if (t.tag === 19 && (t.memoizedProps.revealOrder === "forwards" || t.memoizedProps.revealOrder === "backwards" || t.memoizedProps.revealOrder === "unstable_legacy-backwards" || t.memoizedProps.revealOrder === "together")) {
      if (t.flags & 128) return t;
    } else if (t.child !== null) {
      t.child.return = t, t = t.child;
      continue;
    }
    if (t === e) break;
    for (; t.sibling === null; ) {
      if (t.return === null || t.return === e) return null;
      t = t.return;
    }
    t.sibling.return = t.return, t = t.sibling;
  }
  return null;
}
var $t = 0, X = null, ce = null, je = null, No = !1, Xa = !1, sa = !1, Eo = 0, li = 0, Qa = null, ib = 0;
function Se() {
  throw Error(_(321));
}
function Zc(e, t) {
  if (t === null) return !1;
  for (var n = 0; n < t.length && n < e.length; n++)
    if (!ut(e[n], t[n])) return !1;
  return !0;
}
function Fc(e, t, n, a, l, i) {
  return $t = i, X = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, G.H = e === null || e.memoizedState === null ? zh : lu, sa = !1, i = n(a, l), sa = !1, Xa && (i = lh(
    t,
    n,
    a,
    l
  )), ah(e), i;
}
function ah(e) {
  G.H = ii;
  var t = ce !== null && ce.next !== null;
  if ($t = 0, je = ce = X = null, No = !1, li = 0, Qa = null, t) throw Error(_(300));
  e === null || De || (e = e.dependencies, e !== null && So(e) && (De = !0));
}
function lh(e, t, n, a) {
  X = e;
  var l = 0;
  do {
    if (Xa && (Qa = null), li = 0, Xa = !1, 25 <= l) throw Error(_(301));
    if (l += 1, je = ce = null, e.updateQueue != null) {
      var i = e.updateQueue;
      i.lastEffect = null, i.events = null, i.stores = null, i.memoCache != null && (i.memoCache.index = 0);
    }
    G.H = Rh, i = t(n, a);
  } while (Xa);
  return i;
}
function ob() {
  var e = G.H, t = e.useState()[0];
  return t = typeof t.then == "function" ? bi(t) : t, e = e.useState()[0], (ce !== null ? ce.memoizedState : null) !== e && (X.flags |= 1024), t;
}
function Kc() {
  var e = Eo !== 0;
  return Eo = 0, e;
}
function Jc(e, t, n) {
  t.updateQueue = e.updateQueue, t.flags &= -2053, e.lanes &= ~n;
}
function Ic(e) {
  if (No) {
    for (e = e.memoizedState; e !== null; ) {
      var t = e.queue;
      t !== null && (t.pending = null), e = e.next;
    }
    No = !1;
  }
  $t = 0, je = ce = X = null, Xa = !1, li = Eo = 0, Qa = null;
}
function Ze() {
  var e = {
    memoizedState: null,
    baseState: null,
    baseQueue: null,
    queue: null,
    next: null
  };
  return je === null ? X.memoizedState = je = e : je = je.next = e, je;
}
function Ne() {
  if (ce === null) {
    var e = X.alternate;
    e = e !== null ? e.memoizedState : null;
  } else e = ce.next;
  var t = je === null ? X.memoizedState : je.next;
  if (t !== null)
    je = t, ce = e;
  else {
    if (e === null)
      throw X.alternate === null ? Error(_(467)) : Error(_(310));
    ce = e, e = {
      memoizedState: ce.memoizedState,
      baseState: ce.baseState,
      baseQueue: ce.baseQueue,
      queue: ce.queue,
      next: null
    }, je === null ? X.memoizedState = je = e : je = je.next = e;
  }
  return je;
}
function rs() {
  return { lastEffect: null, events: null, stores: null, memoCache: null };
}
function bi(e) {
  var t = li;
  return li += 1, Qa === null && (Qa = []), e = Wm(Qa, e, t), t = X, (je === null ? t.memoizedState : je.next) === null && (t = t.alternate, G.H = t === null || t.memoizedState === null ? zh : lu), e;
}
function cs(e) {
  if (e !== null && typeof e == "object") {
    if (typeof e.then == "function") return bi(e);
    if (e.$$typeof === qt) return qe(e);
  }
  throw Error(_(438, String(e)));
}
function Wc(e) {
  var t = null, n = X.updateQueue;
  if (n !== null && (t = n.memoCache), t == null) {
    var a = X.alternate;
    a !== null && (a = a.updateQueue, a !== null && (a = a.memoCache, a != null && (t = {
      data: a.data.map(function(l) {
        return l.slice();
      }),
      index: 0
    })));
  }
  if (t == null && (t = { data: [], index: 0 }), n === null && (n = rs(), X.updateQueue = n), n.memoCache = t, n = t.data[t.index], n === void 0)
    for (n = t.data[t.index] = Array(e), a = 0; a < e; a++)
      n[a] = Qy;
  return t.index++, n;
}
function Pt(e, t) {
  return typeof t == "function" ? t(e) : t;
}
function no(e) {
  var t = Ne();
  return $c(t, ce, e);
}
function $c(e, t, n) {
  var a = e.queue;
  if (a === null) throw Error(_(311));
  a.lastRenderedReducer = n;
  var l = e.baseQueue, i = a.pending;
  if (i !== null) {
    if (l !== null) {
      var o = l.next;
      l.next = i.next, i.next = o;
    }
    t.baseQueue = l = i, a.pending = null;
  }
  if (i = e.baseState, l === null) e.memoizedState = i;
  else {
    t = l.next;
    var s = o = null, c = null, u = t, m = !1;
    do {
      var g = u.lane & -536870913;
      if (g !== u.lane ? (P & g) === g : ($t & g) === g) {
        var f = u.revertLane;
        if (f === 0)
          c !== null && (c = c.next = {
            lane: 0,
            revertLane: 0,
            gesture: null,
            action: u.action,
            hasEagerState: u.hasEagerState,
            eagerState: u.eagerState,
            next: null
          }), g === Ia && (m = !0);
        else if (($t & f) === f) {
          u = u.next, f === Ia && (m = !0);
          continue;
        } else
          g = {
            lane: 0,
            revertLane: u.revertLane,
            gesture: null,
            action: u.action,
            hasEagerState: u.hasEagerState,
            eagerState: u.eagerState,
            next: null
          }, c === null ? (s = c = g, o = i) : c = c.next = g, X.lanes |= f, Bn |= f;
        g = u.action, sa && n(i, g), i = u.hasEagerState ? u.eagerState : n(i, g);
      } else
        f = {
          lane: g,
          revertLane: u.revertLane,
          gesture: u.gesture,
          action: u.action,
          hasEagerState: u.hasEagerState,
          eagerState: u.eagerState,
          next: null
        }, c === null ? (s = c = f, o = i) : c = c.next = f, X.lanes |= g, Bn |= g;
      u = u.next;
    } while (u !== null && u !== t);
    if (c === null ? o = i : c.next = s, !ut(i, e.memoizedState) && (De = !0, m && (n = Ya, n !== null)))
      throw n;
    e.memoizedState = i, e.baseState = o, e.baseQueue = c, a.lastRenderedState = i;
  }
  return l === null && (a.lanes = 0), [e.memoizedState, a.dispatch];
}
function Xs(e) {
  var t = Ne(), n = t.queue;
  if (n === null) throw Error(_(311));
  n.lastRenderedReducer = e;
  var a = n.dispatch, l = n.pending, i = t.memoizedState;
  if (l !== null) {
    n.pending = null;
    var o = l = l.next;
    do
      i = e(i, o.action), o = o.next;
    while (o !== l);
    ut(i, t.memoizedState) || (De = !0), t.memoizedState = i, t.baseQueue === null && (t.baseState = i), n.lastRenderedState = i;
  }
  return [i, a];
}
function ih(e, t, n) {
  var a = X, l = Ne(), i = ee;
  if (i) {
    if (n === void 0) throw Error(_(407));
    n = n();
  } else n = t();
  var o = !ut(
    (ce || l).memoizedState,
    n
  );
  if (o && (l.memoizedState = n, De = !0), l = l.queue, Pc(rh.bind(null, a, l, e), [
    e
  ]), l.getSnapshot !== t || o || je !== null && je.memoizedState.tag & 1) {
    if (a.flags |= 2048, $a(
      9,
      { destroy: void 0 },
      sh.bind(
        null,
        a,
        l,
        n,
        t
      ),
      null
    ), fe === null) throw Error(_(349));
    i || $t & 127 || oh(a, t, n);
  }
  return n;
}
function oh(e, t, n) {
  e.flags |= 16384, e = { getSnapshot: t, value: n }, t = X.updateQueue, t === null ? (t = rs(), X.updateQueue = t, t.stores = [e]) : (n = t.stores, n === null ? t.stores = [e] : n.push(e));
}
function sh(e, t, n, a) {
  t.value = n, t.getSnapshot = a, ch(t) && uh(e);
}
function rh(e, t, n) {
  return n(function() {
    ch(t) && uh(e);
  });
}
function ch(e) {
  var t = e.getSnapshot;
  e = e.value;
  try {
    var n = t();
    return !ut(e, n);
  } catch {
    return !0;
  }
}
function uh(e) {
  var t = ma(e, 2);
  t !== null && Pe(t, e, 2);
}
function qr(e) {
  var t = Ze();
  if (typeof e == "function") {
    var n = e;
    if (e = n(), sa) {
      xn(!0);
      try {
        n();
      } finally {
        xn(!1);
      }
    }
  }
  return t.memoizedState = t.baseState = e, t.queue = {
    pending: null,
    lanes: 0,
    dispatch: null,
    lastRenderedReducer: Pt,
    lastRenderedState: e
  }, t;
}
function fh(e, t, n, a) {
  return e.baseState = n, $c(
    e,
    ce,
    typeof a == "function" ? a : Pt
  );
}
function sb(e, t, n, a, l) {
  if (fs(e)) throw Error(_(485));
  if (e = t.action, e !== null) {
    var i = {
      payload: l,
      action: e,
      next: null,
      isTransition: !0,
      status: "pending",
      value: null,
      reason: null,
      listeners: [],
      then: function(o) {
        i.listeners.push(o);
      }
    };
    G.T !== null ? n(!0) : i.isTransition = !1, a(i), n = t.pending, n === null ? (i.next = t.pending = i, dh(t, i)) : (i.next = n.next, t.pending = n.next = i);
  }
}
function dh(e, t) {
  var n = t.action, a = t.payload, l = e.state;
  if (t.isTransition) {
    var i = G.T, o = {};
    G.T = o;
    try {
      var s = n(l, a), c = G.S;
      c !== null && c(o, s), Cf(e, t, s);
    } catch (u) {
      Xr(e, t, u);
    } finally {
      i !== null && o.types !== null && (i.types = o.types), G.T = i;
    }
  } else
    try {
      i = n(l, a), Cf(e, t, i);
    } catch (u) {
      Xr(e, t, u);
    }
}
function Cf(e, t, n) {
  n !== null && typeof n == "object" && typeof n.then == "function" ? n.then(
    function(a) {
      wf(e, t, a);
    },
    function(a) {
      return Xr(e, t, a);
    }
  ) : wf(e, t, n);
}
function wf(e, t, n) {
  t.status = "fulfilled", t.value = n, mh(t), e.state = n, t = e.pending, t !== null && (n = t.next, n === t ? e.pending = null : (n = n.next, t.next = n, dh(e, n)));
}
function Xr(e, t, n) {
  var a = e.pending;
  if (e.pending = null, a !== null) {
    a = a.next;
    do
      t.status = "rejected", t.reason = n, mh(t), t = t.next;
    while (t !== a);
  }
  e.action = null;
}
function mh(e) {
  e = e.listeners;
  for (var t = 0; t < e.length; t++) (0, e[t])();
}
function hh(e, t) {
  return t;
}
function Af(e, t) {
  if (ee) {
    var n = fe.formState;
    if (n !== null) {
      e: {
        var a = X;
        if (ee) {
          if (ge) {
            t: {
              for (var l = ge, i = yt; l.nodeType !== 8; ) {
                if (!i) {
                  l = null;
                  break t;
                }
                if (l = xt(
                  l.nextSibling
                ), l === null) {
                  l = null;
                  break t;
                }
              }
              i = l.data, l = i === "F!" || i === "F" ? l : null;
            }
            if (l) {
              ge = xt(
                l.nextSibling
              ), a = l.data === "F!";
              break e;
            }
          }
          Vn(a);
        }
        a = !1;
      }
      a && (t = n[0]);
    }
  }
  return n = Ze(), n.memoizedState = n.baseState = t, a = {
    pending: null,
    lanes: 0,
    dispatch: null,
    lastRenderedReducer: hh,
    lastRenderedState: t
  }, n.queue = a, n = Dh.bind(
    null,
    X,
    a
  ), a.dispatch = n, a = qr(!1), i = au.bind(
    null,
    X,
    !1,
    a.queue
  ), a = Ze(), l = {
    state: t,
    dispatch: null,
    action: e,
    pending: null
  }, a.queue = l, n = sb.bind(
    null,
    X,
    l,
    i,
    n
  ), l.dispatch = n, a.memoizedState = e, [t, n, !1];
}
function Nf(e) {
  var t = Ne();
  return gh(t, ce, e);
}
function gh(e, t, n) {
  if (t = $c(
    e,
    t,
    hh
  )[0], e = no(Pt)[0], typeof t == "object" && t !== null && typeof t.then == "function")
    try {
      var a = bi(t);
    } catch (o) {
      throw o === ul ? ss : o;
    }
  else a = t;
  t = Ne();
  var l = t.queue, i = l.dispatch;
  return n !== t.memoizedState && (X.flags |= 2048, $a(
    9,
    { destroy: void 0 },
    rb.bind(null, l, n),
    null
  )), [a, i, e];
}
function rb(e, t) {
  e.action = t;
}
function Ef(e) {
  var t = Ne(), n = ce;
  if (n !== null)
    return gh(t, n, e);
  Ne(), t = t.memoizedState, n = Ne();
  var a = n.queue.dispatch;
  return n.memoizedState = e, [t, a, !1];
}
function $a(e, t, n, a) {
  return e = { tag: e, create: n, deps: a, inst: t, next: null }, t = X.updateQueue, t === null && (t = rs(), X.updateQueue = t), n = t.lastEffect, n === null ? t.lastEffect = e.next = e : (a = n.next, n.next = e, e.next = a, t.lastEffect = e), e;
}
function vh() {
  return Ne().memoizedState;
}
function ao(e, t, n, a) {
  var l = Ze();
  X.flags |= e, l.memoizedState = $a(
    1 | t,
    { destroy: void 0 },
    n,
    a === void 0 ? null : a
  );
}
function us(e, t, n, a) {
  var l = Ne();
  a = a === void 0 ? null : a;
  var i = l.memoizedState.inst;
  ce !== null && a !== null && Zc(a, ce.memoizedState.deps) ? l.memoizedState = $a(t, i, n, a) : (X.flags |= e, l.memoizedState = $a(
    1 | t,
    i,
    n,
    a
  ));
}
function jf(e, t) {
  ao(8390656, 8, e, t);
}
function Pc(e, t) {
  us(2048, 8, e, t);
}
function cb(e) {
  X.flags |= 4;
  var t = X.updateQueue;
  if (t === null)
    t = rs(), X.updateQueue = t, t.events = [e];
  else {
    var n = t.events;
    n === null ? t.events = [e] : n.push(e);
  }
}
function ph(e) {
  var t = Ne().memoizedState;
  return cb({ ref: t, nextImpl: e }), function() {
    if (ae & 2) throw Error(_(440));
    return t.impl.apply(void 0, arguments);
  };
}
function yh(e, t) {
  return us(4, 2, e, t);
}
function bh(e, t) {
  return us(4, 4, e, t);
}
function xh(e, t) {
  if (typeof t == "function") {
    e = e();
    var n = t(e);
    return function() {
      typeof n == "function" ? n() : t(null);
    };
  }
  if (t != null)
    return e = e(), t.current = e, function() {
      t.current = null;
    };
}
function Sh(e, t, n) {
  n = n != null ? n.concat([e]) : null, us(4, 4, xh.bind(null, t, e), n);
}
function eu() {
}
function Ch(e, t) {
  var n = Ne();
  t = t === void 0 ? null : t;
  var a = n.memoizedState;
  return t !== null && Zc(t, a[1]) ? a[0] : (n.memoizedState = [e, t], e);
}
function wh(e, t) {
  var n = Ne();
  t = t === void 0 ? null : t;
  var a = n.memoizedState;
  if (t !== null && Zc(t, a[1]))
    return a[0];
  if (a = e(), sa) {
    xn(!0);
    try {
      e();
    } finally {
      xn(!1);
    }
  }
  return n.memoizedState = [a, t], a;
}
function tu(e, t, n) {
  return n === void 0 || $t & 1073741824 && !(P & 261930) ? e.memoizedState = t : (e.memoizedState = n, e = fg(), X.lanes |= e, Bn |= e, n);
}
function Ah(e, t, n, a) {
  return ut(n, t) ? n : Wa.current !== null ? (e = tu(e, n, a), ut(e, t) || (De = !0), e) : !($t & 42) || $t & 1073741824 && !(P & 261930) ? (De = !0, e.memoizedState = n) : (e = fg(), X.lanes |= e, Bn |= e, t);
}
function Nh(e, t, n, a, l) {
  var i = le.p;
  le.p = i !== 0 && 8 > i ? i : 8;
  var o = G.T, s = {};
  G.T = s, au(e, !1, t, n);
  try {
    var c = l(), u = G.S;
    if (u !== null && u(s, c), c !== null && typeof c == "object" && typeof c.then == "function") {
      var m = lb(
        c,
        a
      );
      Ql(
        e,
        t,
        m,
        ct(e)
      );
    } else
      Ql(
        e,
        t,
        a,
        ct(e)
      );
  } catch (g) {
    Ql(
      e,
      t,
      { then: function() {
      }, status: "rejected", reason: g },
      ct()
    );
  } finally {
    le.p = i, o !== null && s.types !== null && (o.types = s.types), G.T = o;
  }
}
function ub() {
}
function Qr(e, t, n, a) {
  if (e.tag !== 5) throw Error(_(476));
  var l = Eh(e).queue;
  Nh(
    e,
    l,
    t,
    Pn,
    n === null ? ub : function() {
      return jh(e), n(a);
    }
  );
}
function Eh(e) {
  var t = e.memoizedState;
  if (t !== null) return t;
  t = {
    memoizedState: Pn,
    baseState: Pn,
    baseQueue: null,
    queue: {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: Pt,
      lastRenderedState: Pn
    },
    next: null
  };
  var n = {};
  return t.next = {
    memoizedState: n,
    baseState: n,
    baseQueue: null,
    queue: {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: Pt,
      lastRenderedState: n
    },
    next: null
  }, e.memoizedState = t, e = e.alternate, e !== null && (e.memoizedState = t), t;
}
function jh(e) {
  var t = Eh(e);
  t.next === null && (t = e.alternate.memoizedState), Ql(
    e,
    t.next.queue,
    {},
    ct()
  );
}
function nu() {
  return qe(ri);
}
function Mh() {
  return Ne().memoizedState;
}
function Th() {
  return Ne().memoizedState;
}
function fb(e) {
  for (var t = e.return; t !== null; ) {
    switch (t.tag) {
      case 24:
      case 3:
        var n = ct();
        e = Mn(n);
        var a = Tn(t, e, n);
        a !== null && (Pe(a, t, n), Yl(a, t, n)), t = { cache: Gc() }, e.payload = t;
        return;
    }
    t = t.return;
  }
}
function db(e, t, n) {
  var a = ct();
  n = {
    lane: a,
    revertLane: 0,
    gesture: null,
    action: n,
    hasEagerState: !1,
    eagerState: null,
    next: null
  }, fs(e) ? _h(t, n) : (n = Vc(e, t, n, a), n !== null && (Pe(n, e, a), Oh(n, t, a)));
}
function Dh(e, t, n) {
  var a = ct();
  Ql(e, t, n, a);
}
function Ql(e, t, n, a) {
  var l = {
    lane: a,
    revertLane: 0,
    gesture: null,
    action: n,
    hasEagerState: !1,
    eagerState: null,
    next: null
  };
  if (fs(e)) _h(t, l);
  else {
    var i = e.alternate;
    if (e.lanes === 0 && (i === null || i.lanes === 0) && (i = t.lastRenderedReducer, i !== null))
      try {
        var o = t.lastRenderedState, s = i(o, n);
        if (l.hasEagerState = !0, l.eagerState = s, ut(s, o))
          return os(e, t, l, 0), fe === null && is(), !1;
      } catch {
      } finally {
      }
    if (n = Vc(e, t, l, a), n !== null)
      return Pe(n, e, a), Oh(n, t, a), !0;
  }
  return !1;
}
function au(e, t, n, a) {
  if (a = {
    lane: 2,
    revertLane: du(),
    gesture: null,
    action: a,
    hasEagerState: !1,
    eagerState: null,
    next: null
  }, fs(e)) {
    if (t) throw Error(_(479));
  } else
    t = Vc(
      e,
      n,
      a,
      2
    ), t !== null && Pe(t, e, 2);
}
function fs(e) {
  var t = e.alternate;
  return e === X || t !== null && t === X;
}
function _h(e, t) {
  Xa = No = !0;
  var n = e.pending;
  n === null ? t.next = t : (t.next = n.next, n.next = t), e.pending = t;
}
function Oh(e, t, n) {
  if (n & 4194048) {
    var a = t.lanes;
    a &= e.pendingLanes, n |= a, t.lanes = n, pm(e, n);
  }
}
var ii = {
  readContext: qe,
  use: cs,
  useCallback: Se,
  useContext: Se,
  useEffect: Se,
  useImperativeHandle: Se,
  useLayoutEffect: Se,
  useInsertionEffect: Se,
  useMemo: Se,
  useReducer: Se,
  useRef: Se,
  useState: Se,
  useDebugValue: Se,
  useDeferredValue: Se,
  useTransition: Se,
  useSyncExternalStore: Se,
  useId: Se,
  useHostTransitionStatus: Se,
  useFormState: Se,
  useActionState: Se,
  useOptimistic: Se,
  useMemoCache: Se,
  useCacheRefresh: Se
};
ii.useEffectEvent = Se;
var zh = {
  readContext: qe,
  use: cs,
  useCallback: function(e, t) {
    return Ze().memoizedState = [
      e,
      t === void 0 ? null : t
    ], e;
  },
  useContext: qe,
  useEffect: jf,
  useImperativeHandle: function(e, t, n) {
    n = n != null ? n.concat([e]) : null, ao(
      4194308,
      4,
      xh.bind(null, t, e),
      n
    );
  },
  useLayoutEffect: function(e, t) {
    return ao(4194308, 4, e, t);
  },
  useInsertionEffect: function(e, t) {
    ao(4, 2, e, t);
  },
  useMemo: function(e, t) {
    var n = Ze();
    t = t === void 0 ? null : t;
    var a = e();
    if (sa) {
      xn(!0);
      try {
        e();
      } finally {
        xn(!1);
      }
    }
    return n.memoizedState = [a, t], a;
  },
  useReducer: function(e, t, n) {
    var a = Ze();
    if (n !== void 0) {
      var l = n(t);
      if (sa) {
        xn(!0);
        try {
          n(t);
        } finally {
          xn(!1);
        }
      }
    } else l = t;
    return a.memoizedState = a.baseState = l, e = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: e,
      lastRenderedState: l
    }, a.queue = e, e = e.dispatch = db.bind(
      null,
      X,
      e
    ), [a.memoizedState, e];
  },
  useRef: function(e) {
    var t = Ze();
    return e = { current: e }, t.memoizedState = e;
  },
  useState: function(e) {
    e = qr(e);
    var t = e.queue, n = Dh.bind(null, X, t);
    return t.dispatch = n, [e.memoizedState, n];
  },
  useDebugValue: eu,
  useDeferredValue: function(e, t) {
    var n = Ze();
    return tu(n, e, t);
  },
  useTransition: function() {
    var e = qr(!1);
    return e = Nh.bind(
      null,
      X,
      e.queue,
      !0,
      !1
    ), Ze().memoizedState = e, [!1, e];
  },
  useSyncExternalStore: function(e, t, n) {
    var a = X, l = Ze();
    if (ee) {
      if (n === void 0)
        throw Error(_(407));
      n = n();
    } else {
      if (n = t(), fe === null)
        throw Error(_(349));
      P & 127 || oh(a, t, n);
    }
    l.memoizedState = n;
    var i = { value: n, getSnapshot: t };
    return l.queue = i, jf(rh.bind(null, a, i, e), [
      e
    ]), a.flags |= 2048, $a(
      9,
      { destroy: void 0 },
      sh.bind(
        null,
        a,
        i,
        n,
        t
      ),
      null
    ), n;
  },
  useId: function() {
    var e = Ze(), t = fe.identifierPrefix;
    if (ee) {
      var n = Mt, a = jt;
      n = (a & ~(1 << 32 - rt(a) - 1)).toString(32) + n, t = "_" + t + "R_" + n, n = Eo++, 0 < n && (t += "H" + n.toString(32)), t += "_";
    } else
      n = ib++, t = "_" + t + "r_" + n.toString(32) + "_";
    return e.memoizedState = t;
  },
  useHostTransitionStatus: nu,
  useFormState: Af,
  useActionState: Af,
  useOptimistic: function(e) {
    var t = Ze();
    t.memoizedState = t.baseState = e;
    var n = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: null,
      lastRenderedState: null
    };
    return t.queue = n, t = au.bind(
      null,
      X,
      !0,
      n
    ), n.dispatch = t, [e, t];
  },
  useMemoCache: Wc,
  useCacheRefresh: function() {
    return Ze().memoizedState = fb.bind(
      null,
      X
    );
  },
  useEffectEvent: function(e) {
    var t = Ze(), n = { impl: e };
    return t.memoizedState = n, function() {
      if (ae & 2)
        throw Error(_(440));
      return n.impl.apply(void 0, arguments);
    };
  }
}, lu = {
  readContext: qe,
  use: cs,
  useCallback: Ch,
  useContext: qe,
  useEffect: Pc,
  useImperativeHandle: Sh,
  useInsertionEffect: yh,
  useLayoutEffect: bh,
  useMemo: wh,
  useReducer: no,
  useRef: vh,
  useState: function() {
    return no(Pt);
  },
  useDebugValue: eu,
  useDeferredValue: function(e, t) {
    var n = Ne();
    return Ah(
      n,
      ce.memoizedState,
      e,
      t
    );
  },
  useTransition: function() {
    var e = no(Pt)[0], t = Ne().memoizedState;
    return [
      typeof e == "boolean" ? e : bi(e),
      t
    ];
  },
  useSyncExternalStore: ih,
  useId: Mh,
  useHostTransitionStatus: nu,
  useFormState: Nf,
  useActionState: Nf,
  useOptimistic: function(e, t) {
    var n = Ne();
    return fh(n, ce, e, t);
  },
  useMemoCache: Wc,
  useCacheRefresh: Th
};
lu.useEffectEvent = ph;
var Rh = {
  readContext: qe,
  use: cs,
  useCallback: Ch,
  useContext: qe,
  useEffect: Pc,
  useImperativeHandle: Sh,
  useInsertionEffect: yh,
  useLayoutEffect: bh,
  useMemo: wh,
  useReducer: Xs,
  useRef: vh,
  useState: function() {
    return Xs(Pt);
  },
  useDebugValue: eu,
  useDeferredValue: function(e, t) {
    var n = Ne();
    return ce === null ? tu(n, e, t) : Ah(
      n,
      ce.memoizedState,
      e,
      t
    );
  },
  useTransition: function() {
    var e = Xs(Pt)[0], t = Ne().memoizedState;
    return [
      typeof e == "boolean" ? e : bi(e),
      t
    ];
  },
  useSyncExternalStore: ih,
  useId: Mh,
  useHostTransitionStatus: nu,
  useFormState: Ef,
  useActionState: Ef,
  useOptimistic: function(e, t) {
    var n = Ne();
    return ce !== null ? fh(n, ce, e, t) : (n.baseState = e, [e, n.queue.dispatch]);
  },
  useMemoCache: Wc,
  useCacheRefresh: Th
};
Rh.useEffectEvent = ph;
function Qs(e, t, n, a) {
  t = e.memoizedState, n = n(a, t), n = n == null ? t : pe({}, t, n), e.memoizedState = n, e.lanes === 0 && (e.updateQueue.baseState = n);
}
var Zr = {
  enqueueSetState: function(e, t, n) {
    e = e._reactInternals;
    var a = ct(), l = Mn(a);
    l.payload = t, n != null && (l.callback = n), t = Tn(e, l, a), t !== null && (Pe(t, e, a), Yl(t, e, a));
  },
  enqueueReplaceState: function(e, t, n) {
    e = e._reactInternals;
    var a = ct(), l = Mn(a);
    l.tag = 1, l.payload = t, n != null && (l.callback = n), t = Tn(e, l, a), t !== null && (Pe(t, e, a), Yl(t, e, a));
  },
  enqueueForceUpdate: function(e, t) {
    e = e._reactInternals;
    var n = ct(), a = Mn(n);
    a.tag = 2, t != null && (a.callback = t), t = Tn(e, a, n), t !== null && (Pe(t, e, n), Yl(t, e, n));
  }
};
function Mf(e, t, n, a, l, i, o) {
  return e = e.stateNode, typeof e.shouldComponentUpdate == "function" ? e.shouldComponentUpdate(a, i, o) : t.prototype && t.prototype.isPureReactComponent ? !ei(n, a) || !ei(l, i) : !0;
}
function Tf(e, t, n, a) {
  e = t.state, typeof t.componentWillReceiveProps == "function" && t.componentWillReceiveProps(n, a), typeof t.UNSAFE_componentWillReceiveProps == "function" && t.UNSAFE_componentWillReceiveProps(n, a), t.state !== e && Zr.enqueueReplaceState(t, t.state, null);
}
function ra(e, t) {
  var n = t;
  if ("ref" in t) {
    n = {};
    for (var a in t)
      a !== "ref" && (n[a] = t[a]);
  }
  if (e = e.defaultProps) {
    n === t && (n = pe({}, n));
    for (var l in e)
      n[l] === void 0 && (n[l] = e[l]);
  }
  return n;
}
function kh(e) {
  yo(e);
}
function Uh(e) {
  console.error(e);
}
function Vh(e) {
  yo(e);
}
function jo(e, t) {
  try {
    var n = e.onUncaughtError;
    n(t.value, { componentStack: t.stack });
  } catch (a) {
    setTimeout(function() {
      throw a;
    });
  }
}
function Df(e, t, n) {
  try {
    var a = e.onCaughtError;
    a(n.value, {
      componentStack: n.stack,
      errorBoundary: t.tag === 1 ? t.stateNode : null
    });
  } catch (l) {
    setTimeout(function() {
      throw l;
    });
  }
}
function Fr(e, t, n) {
  return n = Mn(n), n.tag = 3, n.payload = { element: null }, n.callback = function() {
    jo(e, t);
  }, n;
}
function Lh(e) {
  return e = Mn(e), e.tag = 3, e;
}
function Bh(e, t, n, a) {
  var l = n.type.getDerivedStateFromError;
  if (typeof l == "function") {
    var i = a.value;
    e.payload = function() {
      return l(i);
    }, e.callback = function() {
      Df(t, n, a);
    };
  }
  var o = n.stateNode;
  o !== null && typeof o.componentDidCatch == "function" && (e.callback = function() {
    Df(t, n, a), typeof l != "function" && (Dn === null ? Dn = /* @__PURE__ */ new Set([this]) : Dn.add(this));
    var s = a.stack;
    this.componentDidCatch(a.value, {
      componentStack: s !== null ? s : ""
    });
  });
}
function mb(e, t, n, a, l) {
  if (n.flags |= 32768, a !== null && typeof a == "object" && typeof a.then == "function") {
    if (t = n.alternate, t !== null && cl(
      t,
      n,
      l,
      !0
    ), n = ft.current, n !== null) {
      switch (n.tag) {
        case 31:
        case 13:
          return bt === null ? Oo() : n.alternate === null && Ce === 0 && (Ce = 3), n.flags &= -257, n.flags |= 65536, n.lanes = l, a === Co ? n.flags |= 16384 : (t = n.updateQueue, t === null ? n.updateQueue = /* @__PURE__ */ new Set([a]) : t.add(a), nr(e, a, l)), !1;
        case 22:
          return n.flags |= 65536, a === Co ? n.flags |= 16384 : (t = n.updateQueue, t === null ? (t = {
            transitions: null,
            markerInstances: null,
            retryQueue: /* @__PURE__ */ new Set([a])
          }, n.updateQueue = t) : (n = t.retryQueue, n === null ? t.retryQueue = /* @__PURE__ */ new Set([a]) : n.add(a)), nr(e, a, l)), !1;
      }
      throw Error(_(435, n.tag));
    }
    return nr(e, a, l), Oo(), !1;
  }
  if (ee)
    return t = ft.current, t !== null ? (!(t.flags & 65536) && (t.flags |= 256), t.flags |= 65536, t.lanes = l, a !== Rr && (e = Error(_(422), { cause: a }), ni(pt(e, n)))) : (a !== Rr && (t = Error(_(423), {
      cause: a
    }), ni(
      pt(t, n)
    )), e = e.current.alternate, e.flags |= 65536, l &= -l, e.lanes |= l, a = pt(a, n), l = Fr(
      e.stateNode,
      a,
      l
    ), qs(e, l), Ce !== 4 && (Ce = 2)), !1;
  var i = Error(_(520), { cause: a });
  if (i = pt(i, n), Kl === null ? Kl = [i] : Kl.push(i), Ce !== 4 && (Ce = 2), t === null) return !0;
  a = pt(a, n), n = t;
  do {
    switch (n.tag) {
      case 3:
        return n.flags |= 65536, e = l & -l, n.lanes |= e, e = Fr(n.stateNode, a, e), qs(n, e), !1;
      case 1:
        if (t = n.type, i = n.stateNode, (n.flags & 128) === 0 && (typeof t.getDerivedStateFromError == "function" || i !== null && typeof i.componentDidCatch == "function" && (Dn === null || !Dn.has(i))))
          return n.flags |= 65536, l &= -l, n.lanes |= l, l = Lh(l), Bh(
            l,
            e,
            n,
            a
          ), qs(n, l), !1;
    }
    n = n.return;
  } while (n !== null);
  return !1;
}
var iu = Error(_(461)), De = !1;
function He(e, t, n, a) {
  t.child = e === null ? Pm(t, null, n, a) : oa(
    t,
    e.child,
    n,
    a
  );
}
function _f(e, t, n, a, l) {
  n = n.render;
  var i = t.ref;
  if ("ref" in a) {
    var o = {};
    for (var s in a)
      s !== "ref" && (o[s] = a[s]);
  } else o = a;
  return ia(t), a = Fc(
    e,
    t,
    n,
    o,
    i,
    l
  ), s = Kc(), e !== null && !De ? (Jc(e, t, l), en(e, t, l)) : (ee && s && Bc(t), t.flags |= 1, He(e, t, a, l), t.child);
}
function Of(e, t, n, a, l) {
  if (e === null) {
    var i = n.type;
    return typeof i == "function" && !Lc(i) && i.defaultProps === void 0 && n.compare === null ? (t.tag = 15, t.type = i, Hh(
      e,
      t,
      i,
      a,
      l
    )) : (e = eo(
      n.type,
      null,
      a,
      t,
      t.mode,
      l
    ), e.ref = t.ref, e.return = t, t.child = e);
  }
  if (i = e.child, !ou(e, l)) {
    var o = i.memoizedProps;
    if (n = n.compare, n = n !== null ? n : ei, n(o, a) && e.ref === t.ref)
      return en(e, t, l);
  }
  return t.flags |= 1, e = Zt(i, a), e.ref = t.ref, e.return = t, t.child = e;
}
function Hh(e, t, n, a, l) {
  if (e !== null) {
    var i = e.memoizedProps;
    if (ei(i, a) && e.ref === t.ref)
      if (De = !1, t.pendingProps = a = i, ou(e, l))
        e.flags & 131072 && (De = !0);
      else
        return t.lanes = e.lanes, en(e, t, l);
  }
  return Kr(
    e,
    t,
    n,
    a,
    l
  );
}
function Gh(e, t, n, a) {
  var l = a.children, i = e !== null ? e.memoizedState : null;
  if (e === null && t.stateNode === null && (t.stateNode = {
    _visibility: 1,
    _pendingMarkers: null,
    _retryCache: null,
    _transitions: null
  }), a.mode === "hidden") {
    if (t.flags & 128) {
      if (i = i !== null ? i.baseLanes | n : n, e !== null) {
        for (a = t.child = e.child, l = 0; a !== null; )
          l = l | a.lanes | a.childLanes, a = a.sibling;
        a = l & ~i;
      } else a = 0, t.child = null;
      return zf(
        e,
        t,
        i,
        n,
        a
      );
    }
    if (n & 536870912)
      t.memoizedState = { baseLanes: 0, cachePool: null }, e !== null && to(
        t,
        i !== null ? i.cachePool : null
      ), i !== null ? Sf(t, i) : Gr(), nh(t);
    else
      return a = t.lanes = 536870912, zf(
        e,
        t,
        i !== null ? i.baseLanes | n : n,
        n,
        a
      );
  } else
    i !== null ? (to(t, i.cachePool), Sf(t, i), pn(), t.memoizedState = null) : (e !== null && to(t, null), Gr(), pn());
  return He(e, t, l, n), t.child;
}
function kl(e, t) {
  return e !== null && e.tag === 22 || t.stateNode !== null || (t.stateNode = {
    _visibility: 1,
    _pendingMarkers: null,
    _retryCache: null,
    _transitions: null
  }), t.sibling;
}
function zf(e, t, n, a, l) {
  var i = Yc();
  return i = i === null ? null : { parent: Te._currentValue, pool: i }, t.memoizedState = {
    baseLanes: n,
    cachePool: i
  }, e !== null && to(t, null), Gr(), nh(t), e !== null && cl(e, t, a, !0), t.childLanes = l, null;
}
function lo(e, t) {
  return t = Mo(
    { mode: t.mode, children: t.children },
    e.mode
  ), t.ref = e.ref, e.child = t, t.return = e, t;
}
function Rf(e, t, n) {
  return oa(t, e.child, null, n), e = lo(t, t.pendingProps), e.flags |= 2, at(t), t.memoizedState = null, e;
}
function hb(e, t, n) {
  var a = t.pendingProps, l = (t.flags & 128) !== 0;
  if (t.flags &= -129, e === null) {
    if (ee) {
      if (a.mode === "hidden")
        return e = lo(t, a), t.lanes = 536870912, kl(null, e);
      if (Yr(t), (e = ge) ? (e = zg(
        e,
        yt
      ), e = e !== null && e.data === "&" ? e : null, e !== null && (t.memoizedState = {
        dehydrated: e,
        treeContext: Un !== null ? { id: jt, overflow: Mt } : null,
        retryLane: 536870912,
        hydrationErrors: null
      }, n = Zm(e), n.return = t, t.child = n, Ye = t, ge = null)) : e = null, e === null) throw Vn(t);
      return t.lanes = 536870912, null;
    }
    return lo(t, a);
  }
  var i = e.memoizedState;
  if (i !== null) {
    var o = i.dehydrated;
    if (Yr(t), l)
      if (t.flags & 256)
        t.flags &= -257, t = Rf(
          e,
          t,
          n
        );
      else if (t.memoizedState !== null)
        t.child = e.child, t.flags |= 128, t = null;
      else throw Error(_(558));
    else if (De || cl(e, t, n, !1), l = (n & e.childLanes) !== 0, De || l) {
      if (a = fe, a !== null && (o = ym(a, n), o !== 0 && o !== i.retryLane))
        throw i.retryLane = o, ma(e, o), Pe(a, e, o), iu;
      Oo(), t = Rf(
        e,
        t,
        n
      );
    } else
      e = i.treeContext, ge = xt(o.nextSibling), Ye = t, ee = !0, jn = null, yt = !1, e !== null && Km(t, e), t = lo(t, a), t.flags |= 4096;
    return t;
  }
  return e = Zt(e.child, {
    mode: a.mode,
    children: a.children
  }), e.ref = t.ref, t.child = e, e.return = t, e;
}
function io(e, t) {
  var n = t.ref;
  if (n === null)
    e !== null && e.ref !== null && (t.flags |= 4194816);
  else {
    if (typeof n != "function" && typeof n != "object")
      throw Error(_(284));
    (e === null || e.ref !== n) && (t.flags |= 4194816);
  }
}
function Kr(e, t, n, a, l) {
  return ia(t), n = Fc(
    e,
    t,
    n,
    a,
    void 0,
    l
  ), a = Kc(), e !== null && !De ? (Jc(e, t, l), en(e, t, l)) : (ee && a && Bc(t), t.flags |= 1, He(e, t, n, l), t.child);
}
function kf(e, t, n, a, l, i) {
  return ia(t), t.updateQueue = null, n = lh(
    t,
    a,
    n,
    l
  ), ah(e), a = Kc(), e !== null && !De ? (Jc(e, t, i), en(e, t, i)) : (ee && a && Bc(t), t.flags |= 1, He(e, t, n, i), t.child);
}
function Uf(e, t, n, a, l) {
  if (ia(t), t.stateNode === null) {
    var i = za, o = n.contextType;
    typeof o == "object" && o !== null && (i = qe(o)), i = new n(a, i), t.memoizedState = i.state !== null && i.state !== void 0 ? i.state : null, i.updater = Zr, t.stateNode = i, i._reactInternals = t, i = t.stateNode, i.props = a, i.state = t.memoizedState, i.refs = {}, Xc(t), o = n.contextType, i.context = typeof o == "object" && o !== null ? qe(o) : za, i.state = t.memoizedState, o = n.getDerivedStateFromProps, typeof o == "function" && (Qs(
      t,
      n,
      o,
      a
    ), i.state = t.memoizedState), typeof n.getDerivedStateFromProps == "function" || typeof i.getSnapshotBeforeUpdate == "function" || typeof i.UNSAFE_componentWillMount != "function" && typeof i.componentWillMount != "function" || (o = i.state, typeof i.componentWillMount == "function" && i.componentWillMount(), typeof i.UNSAFE_componentWillMount == "function" && i.UNSAFE_componentWillMount(), o !== i.state && Zr.enqueueReplaceState(i, i.state, null), Xl(t, a, i, l), ql(), i.state = t.memoizedState), typeof i.componentDidMount == "function" && (t.flags |= 4194308), a = !0;
  } else if (e === null) {
    i = t.stateNode;
    var s = t.memoizedProps, c = ra(n, s);
    i.props = c;
    var u = i.context, m = n.contextType;
    o = za, typeof m == "object" && m !== null && (o = qe(m));
    var g = n.getDerivedStateFromProps;
    m = typeof g == "function" || typeof i.getSnapshotBeforeUpdate == "function", s = t.pendingProps !== s, m || typeof i.UNSAFE_componentWillReceiveProps != "function" && typeof i.componentWillReceiveProps != "function" || (s || u !== o) && Tf(
      t,
      i,
      a,
      o
    ), hn = !1;
    var f = t.memoizedState;
    i.state = f, Xl(t, a, i, l), ql(), u = t.memoizedState, s || f !== u || hn ? (typeof g == "function" && (Qs(
      t,
      n,
      g,
      a
    ), u = t.memoizedState), (c = hn || Mf(
      t,
      n,
      c,
      a,
      f,
      u,
      o
    )) ? (m || typeof i.UNSAFE_componentWillMount != "function" && typeof i.componentWillMount != "function" || (typeof i.componentWillMount == "function" && i.componentWillMount(), typeof i.UNSAFE_componentWillMount == "function" && i.UNSAFE_componentWillMount()), typeof i.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof i.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = a, t.memoizedState = u), i.props = a, i.state = u, i.context = o, a = c) : (typeof i.componentDidMount == "function" && (t.flags |= 4194308), a = !1);
  } else {
    i = t.stateNode, Br(e, t), o = t.memoizedProps, m = ra(n, o), i.props = m, g = t.pendingProps, f = i.context, u = n.contextType, c = za, typeof u == "object" && u !== null && (c = qe(u)), s = n.getDerivedStateFromProps, (u = typeof s == "function" || typeof i.getSnapshotBeforeUpdate == "function") || typeof i.UNSAFE_componentWillReceiveProps != "function" && typeof i.componentWillReceiveProps != "function" || (o !== g || f !== c) && Tf(
      t,
      i,
      a,
      c
    ), hn = !1, f = t.memoizedState, i.state = f, Xl(t, a, i, l), ql();
    var p = t.memoizedState;
    o !== g || f !== p || hn || e !== null && e.dependencies !== null && So(e.dependencies) ? (typeof s == "function" && (Qs(
      t,
      n,
      s,
      a
    ), p = t.memoizedState), (m = hn || Mf(
      t,
      n,
      m,
      a,
      f,
      p,
      c
    ) || e !== null && e.dependencies !== null && So(e.dependencies)) ? (u || typeof i.UNSAFE_componentWillUpdate != "function" && typeof i.componentWillUpdate != "function" || (typeof i.componentWillUpdate == "function" && i.componentWillUpdate(a, p, c), typeof i.UNSAFE_componentWillUpdate == "function" && i.UNSAFE_componentWillUpdate(
      a,
      p,
      c
    )), typeof i.componentDidUpdate == "function" && (t.flags |= 4), typeof i.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof i.componentDidUpdate != "function" || o === e.memoizedProps && f === e.memoizedState || (t.flags |= 4), typeof i.getSnapshotBeforeUpdate != "function" || o === e.memoizedProps && f === e.memoizedState || (t.flags |= 1024), t.memoizedProps = a, t.memoizedState = p), i.props = a, i.state = p, i.context = c, a = m) : (typeof i.componentDidUpdate != "function" || o === e.memoizedProps && f === e.memoizedState || (t.flags |= 4), typeof i.getSnapshotBeforeUpdate != "function" || o === e.memoizedProps && f === e.memoizedState || (t.flags |= 1024), a = !1);
  }
  return i = a, io(e, t), a = (t.flags & 128) !== 0, i || a ? (i = t.stateNode, n = a && typeof n.getDerivedStateFromError != "function" ? null : i.render(), t.flags |= 1, e !== null && a ? (t.child = oa(
    t,
    e.child,
    null,
    l
  ), t.child = oa(
    t,
    null,
    n,
    l
  )) : He(e, t, n, l), t.memoizedState = i.state, e = t.child) : e = en(
    e,
    t,
    l
  ), e;
}
function Vf(e, t, n, a) {
  return la(), t.flags |= 256, He(e, t, n, a), t.child;
}
var Zs = {
  dehydrated: null,
  treeContext: null,
  retryLane: 0,
  hydrationErrors: null
};
function Fs(e) {
  return { baseLanes: e, cachePool: Im() };
}
function Ks(e, t, n) {
  return e = e !== null ? e.childLanes & ~n : 0, t && (e |= it), e;
}
function Yh(e, t, n) {
  var a = t.pendingProps, l = !1, i = (t.flags & 128) !== 0, o;
  if ((o = i) || (o = e !== null && e.memoizedState === null ? !1 : (Ae.current & 2) !== 0), o && (l = !0, t.flags &= -129), o = (t.flags & 32) !== 0, t.flags &= -33, e === null) {
    if (ee) {
      if (l ? vn(t) : pn(), (e = ge) ? (e = zg(
        e,
        yt
      ), e = e !== null && e.data !== "&" ? e : null, e !== null && (t.memoizedState = {
        dehydrated: e,
        treeContext: Un !== null ? { id: jt, overflow: Mt } : null,
        retryLane: 536870912,
        hydrationErrors: null
      }, n = Zm(e), n.return = t, t.child = n, Ye = t, ge = null)) : e = null, e === null) throw Vn(t);
      return rc(e) ? t.lanes = 32 : t.lanes = 536870912, null;
    }
    var s = a.children;
    return a = a.fallback, l ? (pn(), l = t.mode, s = Mo(
      { mode: "hidden", children: s },
      l
    ), a = ea(
      a,
      l,
      n,
      null
    ), s.return = t, a.return = t, s.sibling = a, t.child = s, a = t.child, a.memoizedState = Fs(n), a.childLanes = Ks(
      e,
      o,
      n
    ), t.memoizedState = Zs, kl(null, a)) : (vn(t), Jr(t, s));
  }
  var c = e.memoizedState;
  if (c !== null && (s = c.dehydrated, s !== null)) {
    if (i)
      t.flags & 256 ? (vn(t), t.flags &= -257, t = Js(
        e,
        t,
        n
      )) : t.memoizedState !== null ? (pn(), t.child = e.child, t.flags |= 128, t = null) : (pn(), s = a.fallback, l = t.mode, a = Mo(
        { mode: "visible", children: a.children },
        l
      ), s = ea(
        s,
        l,
        n,
        null
      ), s.flags |= 2, a.return = t, s.return = t, a.sibling = s, t.child = a, oa(
        t,
        e.child,
        null,
        n
      ), a = t.child, a.memoizedState = Fs(n), a.childLanes = Ks(
        e,
        o,
        n
      ), t.memoizedState = Zs, t = kl(null, a));
    else if (vn(t), rc(s)) {
      if (o = s.nextSibling && s.nextSibling.dataset, o) var u = o.dgst;
      o = u, a = Error(_(419)), a.stack = "", a.digest = o, ni({ value: a, source: null, stack: null }), t = Js(
        e,
        t,
        n
      );
    } else if (De || cl(e, t, n, !1), o = (n & e.childLanes) !== 0, De || o) {
      if (o = fe, o !== null && (a = ym(o, n), a !== 0 && a !== c.retryLane))
        throw c.retryLane = a, ma(e, a), Pe(o, e, a), iu;
      sc(s) || Oo(), t = Js(
        e,
        t,
        n
      );
    } else
      sc(s) ? (t.flags |= 192, t.child = e.child, t = null) : (e = c.treeContext, ge = xt(
        s.nextSibling
      ), Ye = t, ee = !0, jn = null, yt = !1, e !== null && Km(t, e), t = Jr(
        t,
        a.children
      ), t.flags |= 4096);
    return t;
  }
  return l ? (pn(), s = a.fallback, l = t.mode, c = e.child, u = c.sibling, a = Zt(c, {
    mode: "hidden",
    children: a.children
  }), a.subtreeFlags = c.subtreeFlags & 65011712, u !== null ? s = Zt(
    u,
    s
  ) : (s = ea(
    s,
    l,
    n,
    null
  ), s.flags |= 2), s.return = t, a.return = t, a.sibling = s, t.child = a, kl(null, a), a = t.child, s = e.child.memoizedState, s === null ? s = Fs(n) : (l = s.cachePool, l !== null ? (c = Te._currentValue, l = l.parent !== c ? { parent: c, pool: c } : l) : l = Im(), s = {
    baseLanes: s.baseLanes | n,
    cachePool: l
  }), a.memoizedState = s, a.childLanes = Ks(
    e,
    o,
    n
  ), t.memoizedState = Zs, kl(e.child, a)) : (vn(t), n = e.child, e = n.sibling, n = Zt(n, {
    mode: "visible",
    children: a.children
  }), n.return = t, n.sibling = null, e !== null && (o = t.deletions, o === null ? (t.deletions = [e], t.flags |= 16) : o.push(e)), t.child = n, t.memoizedState = null, n);
}
function Jr(e, t) {
  return t = Mo(
    { mode: "visible", children: t },
    e.mode
  ), t.return = e, e.child = t;
}
function Mo(e, t) {
  return e = lt(22, e, null, t), e.lanes = 0, e;
}
function Js(e, t, n) {
  return oa(t, e.child, null, n), e = Jr(
    t,
    t.pendingProps.children
  ), e.flags |= 2, t.memoizedState = null, e;
}
function Lf(e, t, n) {
  e.lanes |= t;
  var a = e.alternate;
  a !== null && (a.lanes |= t), Ur(e.return, t, n);
}
function Is(e, t, n, a, l, i) {
  var o = e.memoizedState;
  o === null ? e.memoizedState = {
    isBackwards: t,
    rendering: null,
    renderingStartTime: 0,
    last: a,
    tail: n,
    tailMode: l,
    treeForkCount: i
  } : (o.isBackwards = t, o.rendering = null, o.renderingStartTime = 0, o.last = a, o.tail = n, o.tailMode = l, o.treeForkCount = i);
}
function qh(e, t, n) {
  var a = t.pendingProps, l = a.revealOrder, i = a.tail;
  a = a.children;
  var o = Ae.current, s = (o & 2) !== 0;
  if (s ? (o = o & 1 | 2, t.flags |= 128) : o &= 1, de(Ae, o), He(e, t, a, n), a = ee ? ti : 0, !s && e !== null && e.flags & 128)
    e: for (e = t.child; e !== null; ) {
      if (e.tag === 13)
        e.memoizedState !== null && Lf(e, n, t);
      else if (e.tag === 19)
        Lf(e, n, t);
      else if (e.child !== null) {
        e.child.return = e, e = e.child;
        continue;
      }
      if (e === t) break e;
      for (; e.sibling === null; ) {
        if (e.return === null || e.return === t)
          break e;
        e = e.return;
      }
      e.sibling.return = e.return, e = e.sibling;
    }
  switch (l) {
    case "forwards":
      for (n = t.child, l = null; n !== null; )
        e = n.alternate, e !== null && Ao(e) === null && (l = n), n = n.sibling;
      n = l, n === null ? (l = t.child, t.child = null) : (l = n.sibling, n.sibling = null), Is(
        t,
        !1,
        l,
        n,
        i,
        a
      );
      break;
    case "backwards":
    case "unstable_legacy-backwards":
      for (n = null, l = t.child, t.child = null; l !== null; ) {
        if (e = l.alternate, e !== null && Ao(e) === null) {
          t.child = l;
          break;
        }
        e = l.sibling, l.sibling = n, n = l, l = e;
      }
      Is(
        t,
        !0,
        n,
        null,
        i,
        a
      );
      break;
    case "together":
      Is(
        t,
        !1,
        null,
        null,
        void 0,
        a
      );
      break;
    default:
      t.memoizedState = null;
  }
  return t.child;
}
function en(e, t, n) {
  if (e !== null && (t.dependencies = e.dependencies), Bn |= t.lanes, !(n & t.childLanes))
    if (e !== null) {
      if (cl(
        e,
        t,
        n,
        !1
      ), (n & t.childLanes) === 0)
        return null;
    } else return null;
  if (e !== null && t.child !== e.child)
    throw Error(_(153));
  if (t.child !== null) {
    for (e = t.child, n = Zt(e, e.pendingProps), t.child = n, n.return = t; e.sibling !== null; )
      e = e.sibling, n = n.sibling = Zt(e, e.pendingProps), n.return = t;
    n.sibling = null;
  }
  return t.child;
}
function ou(e, t) {
  return e.lanes & t ? !0 : (e = e.dependencies, !!(e !== null && So(e)));
}
function gb(e, t, n) {
  switch (t.tag) {
    case 3:
      ho(t, t.stateNode.containerInfo), gn(t, Te, e.memoizedState.cache), la();
      break;
    case 27:
    case 5:
      wr(t);
      break;
    case 4:
      ho(t, t.stateNode.containerInfo);
      break;
    case 10:
      gn(
        t,
        t.type,
        t.memoizedProps.value
      );
      break;
    case 31:
      if (t.memoizedState !== null)
        return t.flags |= 128, Yr(t), null;
      break;
    case 13:
      var a = t.memoizedState;
      if (a !== null)
        return a.dehydrated !== null ? (vn(t), t.flags |= 128, null) : n & t.child.childLanes ? Yh(e, t, n) : (vn(t), e = en(
          e,
          t,
          n
        ), e !== null ? e.sibling : null);
      vn(t);
      break;
    case 19:
      var l = (e.flags & 128) !== 0;
      if (a = (n & t.childLanes) !== 0, a || (cl(
        e,
        t,
        n,
        !1
      ), a = (n & t.childLanes) !== 0), l) {
        if (a)
          return qh(
            e,
            t,
            n
          );
        t.flags |= 128;
      }
      if (l = t.memoizedState, l !== null && (l.rendering = null, l.tail = null, l.lastEffect = null), de(Ae, Ae.current), a) break;
      return null;
    case 22:
      return t.lanes = 0, Gh(
        e,
        t,
        n,
        t.pendingProps
      );
    case 24:
      gn(t, Te, e.memoizedState.cache);
  }
  return en(e, t, n);
}
function Xh(e, t, n) {
  if (e !== null)
    if (e.memoizedProps !== t.pendingProps)
      De = !0;
    else {
      if (!ou(e, n) && !(t.flags & 128))
        return De = !1, gb(
          e,
          t,
          n
        );
      De = !!(e.flags & 131072);
    }
  else
    De = !1, ee && t.flags & 1048576 && Fm(t, ti, t.index);
  switch (t.lanes = 0, t.tag) {
    case 16:
      e: {
        var a = t.pendingProps;
        if (e = In(t.elementType), t.type = e, typeof e == "function")
          Lc(e) ? (a = ra(e, a), t.tag = 1, t = Uf(
            null,
            t,
            e,
            a,
            n
          )) : (t.tag = 0, t = Kr(
            null,
            t,
            e,
            a,
            n
          ));
        else {
          if (e != null) {
            var l = e.$$typeof;
            if (l === Ac) {
              t.tag = 11, t = _f(
                null,
                t,
                e,
                a,
                n
              );
              break e;
            } else if (l === Nc) {
              t.tag = 14, t = Of(
                null,
                t,
                e,
                a,
                n
              );
              break e;
            }
          }
          throw t = Sr(e) || e, Error(_(306, t, ""));
        }
      }
      return t;
    case 0:
      return Kr(
        e,
        t,
        t.type,
        t.pendingProps,
        n
      );
    case 1:
      return a = t.type, l = ra(
        a,
        t.pendingProps
      ), Uf(
        e,
        t,
        a,
        l,
        n
      );
    case 3:
      e: {
        if (ho(
          t,
          t.stateNode.containerInfo
        ), e === null) throw Error(_(387));
        a = t.pendingProps;
        var i = t.memoizedState;
        l = i.element, Br(e, t), Xl(t, a, null, n);
        var o = t.memoizedState;
        if (a = o.cache, gn(t, Te, a), a !== i.cache && Vr(
          t,
          [Te],
          n,
          !0
        ), ql(), a = o.element, i.isDehydrated)
          if (i = {
            element: a,
            isDehydrated: !1,
            cache: o.cache
          }, t.updateQueue.baseState = i, t.memoizedState = i, t.flags & 256) {
            t = Vf(
              e,
              t,
              a,
              n
            );
            break e;
          } else if (a !== l) {
            l = pt(
              Error(_(424)),
              t
            ), ni(l), t = Vf(
              e,
              t,
              a,
              n
            );
            break e;
          } else {
            switch (e = t.stateNode.containerInfo, e.nodeType) {
              case 9:
                e = e.body;
                break;
              default:
                e = e.nodeName === "HTML" ? e.ownerDocument.body : e;
            }
            for (ge = xt(e.firstChild), Ye = t, ee = !0, jn = null, yt = !0, n = Pm(
              t,
              null,
              a,
              n
            ), t.child = n; n; )
              n.flags = n.flags & -3 | 4096, n = n.sibling;
          }
        else {
          if (la(), a === l) {
            t = en(
              e,
              t,
              n
            );
            break e;
          }
          He(e, t, a, n);
        }
        t = t.child;
      }
      return t;
    case 26:
      return io(e, t), e === null ? (n = ld(
        t.type,
        null,
        t.pendingProps,
        null
      )) ? t.memoizedState = n : ee || (n = t.type, e = t.pendingProps, a = Uo(
        En.current
      ).createElement(n), a[Ge] = t, a[et] = e, Xe(a, n, e), Ue(a), t.stateNode = a) : t.memoizedState = ld(
        t.type,
        e.memoizedProps,
        t.pendingProps,
        e.memoizedState
      ), null;
    case 27:
      return wr(t), e === null && ee && (a = t.stateNode = Rg(
        t.type,
        t.pendingProps,
        En.current
      ), Ye = t, yt = !0, l = ge, Yn(t.type) ? (cc = l, ge = xt(a.firstChild)) : ge = l), He(
        e,
        t,
        t.pendingProps.children,
        n
      ), io(e, t), e === null && (t.flags |= 4194304), t.child;
    case 5:
      return e === null && ee && ((l = a = ge) && (a = Qb(
        a,
        t.type,
        t.pendingProps,
        yt
      ), a !== null ? (t.stateNode = a, Ye = t, ge = xt(a.firstChild), yt = !1, l = !0) : l = !1), l || Vn(t)), wr(t), l = t.type, i = t.pendingProps, o = e !== null ? e.memoizedProps : null, a = i.children, ic(l, i) ? a = null : o !== null && ic(l, o) && (t.flags |= 32), t.memoizedState !== null && (l = Fc(
        e,
        t,
        ob,
        null,
        null,
        n
      ), ri._currentValue = l), io(e, t), He(e, t, a, n), t.child;
    case 6:
      return e === null && ee && ((e = n = ge) && (n = Zb(
        n,
        t.pendingProps,
        yt
      ), n !== null ? (t.stateNode = n, Ye = t, ge = null, e = !0) : e = !1), e || Vn(t)), null;
    case 13:
      return Yh(e, t, n);
    case 4:
      return ho(
        t,
        t.stateNode.containerInfo
      ), a = t.pendingProps, e === null ? t.child = oa(
        t,
        null,
        a,
        n
      ) : He(e, t, a, n), t.child;
    case 11:
      return _f(
        e,
        t,
        t.type,
        t.pendingProps,
        n
      );
    case 7:
      return He(
        e,
        t,
        t.pendingProps,
        n
      ), t.child;
    case 8:
      return He(
        e,
        t,
        t.pendingProps.children,
        n
      ), t.child;
    case 12:
      return He(
        e,
        t,
        t.pendingProps.children,
        n
      ), t.child;
    case 10:
      return a = t.pendingProps, gn(t, t.type, a.value), He(e, t, a.children, n), t.child;
    case 9:
      return l = t.type._context, a = t.pendingProps.children, ia(t), l = qe(l), a = a(l), t.flags |= 1, He(e, t, a, n), t.child;
    case 14:
      return Of(
        e,
        t,
        t.type,
        t.pendingProps,
        n
      );
    case 15:
      return Hh(
        e,
        t,
        t.type,
        t.pendingProps,
        n
      );
    case 19:
      return qh(e, t, n);
    case 31:
      return hb(e, t, n);
    case 22:
      return Gh(
        e,
        t,
        n,
        t.pendingProps
      );
    case 24:
      return ia(t), a = qe(Te), e === null ? (l = Yc(), l === null && (l = fe, i = Gc(), l.pooledCache = i, i.refCount++, i !== null && (l.pooledCacheLanes |= n), l = i), t.memoizedState = { parent: a, cache: l }, Xc(t), gn(t, Te, l)) : (e.lanes & n && (Br(e, t), Xl(t, null, null, n), ql()), l = e.memoizedState, i = t.memoizedState, l.parent !== a ? (l = { parent: a, cache: a }, t.memoizedState = l, t.lanes === 0 && (t.memoizedState = t.updateQueue.baseState = l), gn(t, Te, a)) : (a = i.cache, gn(t, Te, a), a !== l.cache && Vr(
        t,
        [Te],
        n,
        !0
      ))), He(
        e,
        t,
        t.pendingProps.children,
        n
      ), t.child;
    case 29:
      throw t.pendingProps;
  }
  throw Error(_(156, t.tag));
}
function Ut(e) {
  e.flags |= 4;
}
function Ws(e, t, n, a, l) {
  if ((t = (e.mode & 32) !== 0) && (t = !1), t) {
    if (e.flags |= 16777216, (l & 335544128) === l)
      if (e.stateNode.complete) e.flags |= 8192;
      else if (hg()) e.flags |= 8192;
      else
        throw na = Co, qc;
  } else e.flags &= -16777217;
}
function Bf(e, t) {
  if (t.type !== "stylesheet" || t.state.loading & 4)
    e.flags &= -16777217;
  else if (e.flags |= 16777216, !Vg(t))
    if (hg()) e.flags |= 8192;
    else
      throw na = Co, qc;
}
function Bi(e, t) {
  t !== null && (e.flags |= 4), e.flags & 16384 && (t = e.tag !== 22 ? gm() : 536870912, e.lanes |= t, Pa |= t);
}
function jl(e, t) {
  if (!ee)
    switch (e.tailMode) {
      case "hidden":
        t = e.tail;
        for (var n = null; t !== null; )
          t.alternate !== null && (n = t), t = t.sibling;
        n === null ? e.tail = null : n.sibling = null;
        break;
      case "collapsed":
        n = e.tail;
        for (var a = null; n !== null; )
          n.alternate !== null && (a = n), n = n.sibling;
        a === null ? t || e.tail === null ? e.tail = null : e.tail.sibling = null : a.sibling = null;
    }
}
function he(e) {
  var t = e.alternate !== null && e.alternate.child === e.child, n = 0, a = 0;
  if (t)
    for (var l = e.child; l !== null; )
      n |= l.lanes | l.childLanes, a |= l.subtreeFlags & 65011712, a |= l.flags & 65011712, l.return = e, l = l.sibling;
  else
    for (l = e.child; l !== null; )
      n |= l.lanes | l.childLanes, a |= l.subtreeFlags, a |= l.flags, l.return = e, l = l.sibling;
  return e.subtreeFlags |= a, e.childLanes = n, t;
}
function vb(e, t, n) {
  var a = t.pendingProps;
  switch (Hc(t), t.tag) {
    case 16:
    case 15:
    case 0:
    case 11:
    case 7:
    case 8:
    case 12:
    case 9:
    case 14:
      return he(t), null;
    case 1:
      return he(t), null;
    case 3:
      return n = t.stateNode, a = null, e !== null && (a = e.memoizedState.cache), t.memoizedState.cache !== a && (t.flags |= 2048), Ft(Te), Fa(), n.pendingContext && (n.context = n.pendingContext, n.pendingContext = null), (e === null || e.child === null) && (pa(t) ? Ut(t) : e === null || e.memoizedState.isDehydrated && !(t.flags & 256) || (t.flags |= 1024, Ys())), he(t), null;
    case 26:
      var l = t.type, i = t.memoizedState;
      return e === null ? (Ut(t), i !== null ? (he(t), Bf(t, i)) : (he(t), Ws(
        t,
        l,
        null,
        a,
        n
      ))) : i ? i !== e.memoizedState ? (Ut(t), he(t), Bf(t, i)) : (he(t), t.flags &= -16777217) : (e = e.memoizedProps, e !== a && Ut(t), he(t), Ws(
        t,
        l,
        e,
        a,
        n
      )), null;
    case 27:
      if (go(t), n = En.current, l = t.type, e !== null && t.stateNode != null)
        e.memoizedProps !== a && Ut(t);
      else {
        if (!a) {
          if (t.stateNode === null)
            throw Error(_(166));
          return he(t), null;
        }
        e = Dt.current, pa(t) ? hf(t) : (e = Rg(l, a, n), t.stateNode = e, Ut(t));
      }
      return he(t), null;
    case 5:
      if (go(t), l = t.type, e !== null && t.stateNode != null)
        e.memoizedProps !== a && Ut(t);
      else {
        if (!a) {
          if (t.stateNode === null)
            throw Error(_(166));
          return he(t), null;
        }
        if (i = Dt.current, pa(t))
          hf(t);
        else {
          var o = Uo(
            En.current
          );
          switch (i) {
            case 1:
              i = o.createElementNS(
                "http://www.w3.org/2000/svg",
                l
              );
              break;
            case 2:
              i = o.createElementNS(
                "http://www.w3.org/1998/Math/MathML",
                l
              );
              break;
            default:
              switch (l) {
                case "svg":
                  i = o.createElementNS(
                    "http://www.w3.org/2000/svg",
                    l
                  );
                  break;
                case "math":
                  i = o.createElementNS(
                    "http://www.w3.org/1998/Math/MathML",
                    l
                  );
                  break;
                case "script":
                  i = o.createElement("div"), i.innerHTML = "<script><\/script>", i = i.removeChild(
                    i.firstChild
                  );
                  break;
                case "select":
                  i = typeof a.is == "string" ? o.createElement("select", {
                    is: a.is
                  }) : o.createElement("select"), a.multiple ? i.multiple = !0 : a.size && (i.size = a.size);
                  break;
                default:
                  i = typeof a.is == "string" ? o.createElement(l, { is: a.is }) : o.createElement(l);
              }
          }
          i[Ge] = t, i[et] = a;
          e: for (o = t.child; o !== null; ) {
            if (o.tag === 5 || o.tag === 6)
              i.appendChild(o.stateNode);
            else if (o.tag !== 4 && o.tag !== 27 && o.child !== null) {
              o.child.return = o, o = o.child;
              continue;
            }
            if (o === t) break e;
            for (; o.sibling === null; ) {
              if (o.return === null || o.return === t)
                break e;
              o = o.return;
            }
            o.sibling.return = o.return, o = o.sibling;
          }
          t.stateNode = i;
          e: switch (Xe(i, l, a), l) {
            case "button":
            case "input":
            case "select":
            case "textarea":
              a = !!a.autoFocus;
              break e;
            case "img":
              a = !0;
              break e;
            default:
              a = !1;
          }
          a && Ut(t);
        }
      }
      return he(t), Ws(
        t,
        t.type,
        e === null ? null : e.memoizedProps,
        t.pendingProps,
        n
      ), null;
    case 6:
      if (e && t.stateNode != null)
        e.memoizedProps !== a && Ut(t);
      else {
        if (typeof a != "string" && t.stateNode === null)
          throw Error(_(166));
        if (e = En.current, pa(t)) {
          if (e = t.stateNode, n = t.memoizedProps, a = null, l = Ye, l !== null)
            switch (l.tag) {
              case 27:
              case 5:
                a = l.memoizedProps;
            }
          e[Ge] = t, e = !!(e.nodeValue === n || a !== null && a.suppressHydrationWarning === !0 || Dg(e.nodeValue, n)), e || Vn(t, !0);
        } else
          e = Uo(e).createTextNode(
            a
          ), e[Ge] = t, t.stateNode = e;
      }
      return he(t), null;
    case 31:
      if (n = t.memoizedState, e === null || e.memoizedState !== null) {
        if (a = pa(t), n !== null) {
          if (e === null) {
            if (!a) throw Error(_(318));
            if (e = t.memoizedState, e = e !== null ? e.dehydrated : null, !e) throw Error(_(557));
            e[Ge] = t;
          } else
            la(), !(t.flags & 128) && (t.memoizedState = null), t.flags |= 4;
          he(t), e = !1;
        } else
          n = Ys(), e !== null && e.memoizedState !== null && (e.memoizedState.hydrationErrors = n), e = !0;
        if (!e)
          return t.flags & 256 ? (at(t), t) : (at(t), null);
        if (t.flags & 128)
          throw Error(_(558));
      }
      return he(t), null;
    case 13:
      if (a = t.memoizedState, e === null || e.memoizedState !== null && e.memoizedState.dehydrated !== null) {
        if (l = pa(t), a !== null && a.dehydrated !== null) {
          if (e === null) {
            if (!l) throw Error(_(318));
            if (l = t.memoizedState, l = l !== null ? l.dehydrated : null, !l) throw Error(_(317));
            l[Ge] = t;
          } else
            la(), !(t.flags & 128) && (t.memoizedState = null), t.flags |= 4;
          he(t), l = !1;
        } else
          l = Ys(), e !== null && e.memoizedState !== null && (e.memoizedState.hydrationErrors = l), l = !0;
        if (!l)
          return t.flags & 256 ? (at(t), t) : (at(t), null);
      }
      return at(t), t.flags & 128 ? (t.lanes = n, t) : (n = a !== null, e = e !== null && e.memoizedState !== null, n && (a = t.child, l = null, a.alternate !== null && a.alternate.memoizedState !== null && a.alternate.memoizedState.cachePool !== null && (l = a.alternate.memoizedState.cachePool.pool), i = null, a.memoizedState !== null && a.memoizedState.cachePool !== null && (i = a.memoizedState.cachePool.pool), i !== l && (a.flags |= 2048)), n !== e && n && (t.child.flags |= 8192), Bi(t, t.updateQueue), he(t), null);
    case 4:
      return Fa(), e === null && mu(t.stateNode.containerInfo), he(t), null;
    case 10:
      return Ft(t.type), he(t), null;
    case 19:
      if (Le(Ae), a = t.memoizedState, a === null) return he(t), null;
      if (l = (t.flags & 128) !== 0, i = a.rendering, i === null)
        if (l) jl(a, !1);
        else {
          if (Ce !== 0 || e !== null && e.flags & 128)
            for (e = t.child; e !== null; ) {
              if (i = Ao(e), i !== null) {
                for (t.flags |= 128, jl(a, !1), e = i.updateQueue, t.updateQueue = e, Bi(t, e), t.subtreeFlags = 0, e = n, n = t.child; n !== null; )
                  Qm(n, e), n = n.sibling;
                return de(
                  Ae,
                  Ae.current & 1 | 2
                ), ee && Gt(t, a.treeForkCount), t.child;
              }
              e = e.sibling;
            }
          a.tail !== null && ot() > Do && (t.flags |= 128, l = !0, jl(a, !1), t.lanes = 4194304);
        }
      else {
        if (!l)
          if (e = Ao(i), e !== null) {
            if (t.flags |= 128, l = !0, e = e.updateQueue, t.updateQueue = e, Bi(t, e), jl(a, !0), a.tail === null && a.tailMode === "hidden" && !i.alternate && !ee)
              return he(t), null;
          } else
            2 * ot() - a.renderingStartTime > Do && n !== 536870912 && (t.flags |= 128, l = !0, jl(a, !1), t.lanes = 4194304);
        a.isBackwards ? (i.sibling = t.child, t.child = i) : (e = a.last, e !== null ? e.sibling = i : t.child = i, a.last = i);
      }
      return a.tail !== null ? (e = a.tail, a.rendering = e, a.tail = e.sibling, a.renderingStartTime = ot(), e.sibling = null, n = Ae.current, de(
        Ae,
        l ? n & 1 | 2 : n & 1
      ), ee && Gt(t, a.treeForkCount), e) : (he(t), null);
    case 22:
    case 23:
      return at(t), Qc(), a = t.memoizedState !== null, e !== null ? e.memoizedState !== null !== a && (t.flags |= 8192) : a && (t.flags |= 8192), a ? n & 536870912 && !(t.flags & 128) && (he(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : he(t), n = t.updateQueue, n !== null && Bi(t, n.retryQueue), n = null, e !== null && e.memoizedState !== null && e.memoizedState.cachePool !== null && (n = e.memoizedState.cachePool.pool), a = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (a = t.memoizedState.cachePool.pool), a !== n && (t.flags |= 2048), e !== null && Le(ta), null;
    case 24:
      return n = null, e !== null && (n = e.memoizedState.cache), t.memoizedState.cache !== n && (t.flags |= 2048), Ft(Te), he(t), null;
    case 25:
      return null;
    case 30:
      return null;
  }
  throw Error(_(156, t.tag));
}
function pb(e, t) {
  switch (Hc(t), t.tag) {
    case 1:
      return e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
    case 3:
      return Ft(Te), Fa(), e = t.flags, e & 65536 && !(e & 128) ? (t.flags = e & -65537 | 128, t) : null;
    case 26:
    case 27:
    case 5:
      return go(t), null;
    case 31:
      if (t.memoizedState !== null) {
        if (at(t), t.alternate === null)
          throw Error(_(340));
        la();
      }
      return e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
    case 13:
      if (at(t), e = t.memoizedState, e !== null && e.dehydrated !== null) {
        if (t.alternate === null)
          throw Error(_(340));
        la();
      }
      return e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
    case 19:
      return Le(Ae), null;
    case 4:
      return Fa(), null;
    case 10:
      return Ft(t.type), null;
    case 22:
    case 23:
      return at(t), Qc(), e !== null && Le(ta), e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
    case 24:
      return Ft(Te), null;
    case 25:
      return null;
    default:
      return null;
  }
}
function Qh(e, t) {
  switch (Hc(t), t.tag) {
    case 3:
      Ft(Te), Fa();
      break;
    case 26:
    case 27:
    case 5:
      go(t);
      break;
    case 4:
      Fa();
      break;
    case 31:
      t.memoizedState !== null && at(t);
      break;
    case 13:
      at(t);
      break;
    case 19:
      Le(Ae);
      break;
    case 10:
      Ft(t.type);
      break;
    case 22:
    case 23:
      at(t), Qc(), e !== null && Le(ta);
      break;
    case 24:
      Ft(Te);
  }
}
function xi(e, t) {
  try {
    var n = t.updateQueue, a = n !== null ? n.lastEffect : null;
    if (a !== null) {
      var l = a.next;
      n = l;
      do {
        if ((n.tag & e) === e) {
          a = void 0;
          var i = n.create, o = n.inst;
          a = i(), o.destroy = a;
        }
        n = n.next;
      } while (n !== l);
    }
  } catch (s) {
    se(t, t.return, s);
  }
}
function Ln(e, t, n) {
  try {
    var a = t.updateQueue, l = a !== null ? a.lastEffect : null;
    if (l !== null) {
      var i = l.next;
      a = i;
      do {
        if ((a.tag & e) === e) {
          var o = a.inst, s = o.destroy;
          if (s !== void 0) {
            o.destroy = void 0, l = t;
            var c = n, u = s;
            try {
              u();
            } catch (m) {
              se(
                l,
                c,
                m
              );
            }
          }
        }
        a = a.next;
      } while (a !== i);
    }
  } catch (m) {
    se(t, t.return, m);
  }
}
function Zh(e) {
  var t = e.updateQueue;
  if (t !== null) {
    var n = e.stateNode;
    try {
      th(t, n);
    } catch (a) {
      se(e, e.return, a);
    }
  }
}
function Fh(e, t, n) {
  n.props = ra(
    e.type,
    e.memoizedProps
  ), n.state = e.memoizedState;
  try {
    n.componentWillUnmount();
  } catch (a) {
    se(e, t, a);
  }
}
function Zl(e, t) {
  try {
    var n = e.ref;
    if (n !== null) {
      switch (e.tag) {
        case 26:
        case 27:
        case 5:
          var a = e.stateNode;
          break;
        case 30:
          a = e.stateNode;
          break;
        default:
          a = e.stateNode;
      }
      typeof n == "function" ? e.refCleanup = n(a) : n.current = a;
    }
  } catch (l) {
    se(e, t, l);
  }
}
function Tt(e, t) {
  var n = e.ref, a = e.refCleanup;
  if (n !== null)
    if (typeof a == "function")
      try {
        a();
      } catch (l) {
        se(e, t, l);
      } finally {
        e.refCleanup = null, e = e.alternate, e != null && (e.refCleanup = null);
      }
    else if (typeof n == "function")
      try {
        n(null);
      } catch (l) {
        se(e, t, l);
      }
    else n.current = null;
}
function Kh(e) {
  var t = e.type, n = e.memoizedProps, a = e.stateNode;
  try {
    e: switch (t) {
      case "button":
      case "input":
      case "select":
      case "textarea":
        n.autoFocus && a.focus();
        break e;
      case "img":
        n.src ? a.src = n.src : n.srcSet && (a.srcset = n.srcSet);
    }
  } catch (l) {
    se(e, e.return, l);
  }
}
function $s(e, t, n) {
  try {
    var a = e.stateNode;
    Bb(a, e.type, n, t), a[et] = t;
  } catch (l) {
    se(e, e.return, l);
  }
}
function Jh(e) {
  return e.tag === 5 || e.tag === 3 || e.tag === 26 || e.tag === 27 && Yn(e.type) || e.tag === 4;
}
function Ps(e) {
  e: for (; ; ) {
    for (; e.sibling === null; ) {
      if (e.return === null || Jh(e.return)) return null;
      e = e.return;
    }
    for (e.sibling.return = e.return, e = e.sibling; e.tag !== 5 && e.tag !== 6 && e.tag !== 18; ) {
      if (e.tag === 27 && Yn(e.type) || e.flags & 2 || e.child === null || e.tag === 4) continue e;
      e.child.return = e, e = e.child;
    }
    if (!(e.flags & 2)) return e.stateNode;
  }
}
function Ir(e, t, n) {
  var a = e.tag;
  if (a === 5 || a === 6)
    e = e.stateNode, t ? (n.nodeType === 9 ? n.body : n.nodeName === "HTML" ? n.ownerDocument.body : n).insertBefore(e, t) : (t = n.nodeType === 9 ? n.body : n.nodeName === "HTML" ? n.ownerDocument.body : n, t.appendChild(e), n = n._reactRootContainer, n != null || t.onclick !== null || (t.onclick = Xt));
  else if (a !== 4 && (a === 27 && Yn(e.type) && (n = e.stateNode, t = null), e = e.child, e !== null))
    for (Ir(e, t, n), e = e.sibling; e !== null; )
      Ir(e, t, n), e = e.sibling;
}
function To(e, t, n) {
  var a = e.tag;
  if (a === 5 || a === 6)
    e = e.stateNode, t ? n.insertBefore(e, t) : n.appendChild(e);
  else if (a !== 4 && (a === 27 && Yn(e.type) && (n = e.stateNode), e = e.child, e !== null))
    for (To(e, t, n), e = e.sibling; e !== null; )
      To(e, t, n), e = e.sibling;
}
function Ih(e) {
  var t = e.stateNode, n = e.memoizedProps;
  try {
    for (var a = e.type, l = t.attributes; l.length; )
      t.removeAttributeNode(l[0]);
    Xe(t, a, n), t[Ge] = e, t[et] = n;
  } catch (i) {
    se(e, e.return, i);
  }
}
var Yt = !1, Me = !1, er = !1, Hf = typeof WeakSet == "function" ? WeakSet : Set, ke = null;
function yb(e, t) {
  if (e = e.containerInfo, ac = Ho, e = Vm(e), kc(e)) {
    if ("selectionStart" in e)
      var n = {
        start: e.selectionStart,
        end: e.selectionEnd
      };
    else
      e: {
        n = (n = e.ownerDocument) && n.defaultView || window;
        var a = n.getSelection && n.getSelection();
        if (a && a.rangeCount !== 0) {
          n = a.anchorNode;
          var l = a.anchorOffset, i = a.focusNode;
          a = a.focusOffset;
          try {
            n.nodeType, i.nodeType;
          } catch {
            n = null;
            break e;
          }
          var o = 0, s = -1, c = -1, u = 0, m = 0, g = e, f = null;
          t: for (; ; ) {
            for (var p; g !== n || l !== 0 && g.nodeType !== 3 || (s = o + l), g !== i || a !== 0 && g.nodeType !== 3 || (c = o + a), g.nodeType === 3 && (o += g.nodeValue.length), (p = g.firstChild) !== null; )
              f = g, g = p;
            for (; ; ) {
              if (g === e) break t;
              if (f === n && ++u === l && (s = o), f === i && ++m === a && (c = o), (p = g.nextSibling) !== null) break;
              g = f, f = g.parentNode;
            }
            g = p;
          }
          n = s === -1 || c === -1 ? null : { start: s, end: c };
        } else n = null;
      }
    n = n || { start: 0, end: 0 };
  } else n = null;
  for (lc = { focusedElem: e, selectionRange: n }, Ho = !1, ke = t; ke !== null; )
    if (t = ke, e = t.child, (t.subtreeFlags & 1028) !== 0 && e !== null)
      e.return = t, ke = e;
    else
      for (; ke !== null; ) {
        switch (t = ke, i = t.alternate, e = t.flags, t.tag) {
          case 0:
            if (e & 4 && (e = t.updateQueue, e = e !== null ? e.events : null, e !== null))
              for (n = 0; n < e.length; n++)
                l = e[n], l.ref.impl = l.nextImpl;
            break;
          case 11:
          case 15:
            break;
          case 1:
            if (e & 1024 && i !== null) {
              e = void 0, n = t, l = i.memoizedProps, i = i.memoizedState, a = n.stateNode;
              try {
                var C = ra(
                  n.type,
                  l
                );
                e = a.getSnapshotBeforeUpdate(
                  C,
                  i
                ), a.__reactInternalSnapshotBeforeUpdate = e;
              } catch (x) {
                se(
                  n,
                  n.return,
                  x
                );
              }
            }
            break;
          case 3:
            if (e & 1024) {
              if (e = t.stateNode.containerInfo, n = e.nodeType, n === 9)
                oc(e);
              else if (n === 1)
                switch (e.nodeName) {
                  case "HEAD":
                  case "HTML":
                  case "BODY":
                    oc(e);
                    break;
                  default:
                    e.textContent = "";
                }
            }
            break;
          case 5:
          case 26:
          case 27:
          case 6:
          case 4:
          case 17:
            break;
          default:
            if (e & 1024) throw Error(_(163));
        }
        if (e = t.sibling, e !== null) {
          e.return = t.return, ke = e;
          break;
        }
        ke = t.return;
      }
}
function Wh(e, t, n) {
  var a = n.flags;
  switch (n.tag) {
    case 0:
    case 11:
    case 15:
      Lt(e, n), a & 4 && xi(5, n);
      break;
    case 1:
      if (Lt(e, n), a & 4)
        if (e = n.stateNode, t === null)
          try {
            e.componentDidMount();
          } catch (o) {
            se(n, n.return, o);
          }
        else {
          var l = ra(
            n.type,
            t.memoizedProps
          );
          t = t.memoizedState;
          try {
            e.componentDidUpdate(
              l,
              t,
              e.__reactInternalSnapshotBeforeUpdate
            );
          } catch (o) {
            se(
              n,
              n.return,
              o
            );
          }
        }
      a & 64 && Zh(n), a & 512 && Zl(n, n.return);
      break;
    case 3:
      if (Lt(e, n), a & 64 && (e = n.updateQueue, e !== null)) {
        if (t = null, n.child !== null)
          switch (n.child.tag) {
            case 27:
            case 5:
              t = n.child.stateNode;
              break;
            case 1:
              t = n.child.stateNode;
          }
        try {
          th(e, t);
        } catch (o) {
          se(n, n.return, o);
        }
      }
      break;
    case 27:
      t === null && a & 4 && Ih(n);
    case 26:
    case 5:
      Lt(e, n), t === null && a & 4 && Kh(n), a & 512 && Zl(n, n.return);
      break;
    case 12:
      Lt(e, n);
      break;
    case 31:
      Lt(e, n), a & 4 && eg(e, n);
      break;
    case 13:
      Lt(e, n), a & 4 && tg(e, n), a & 64 && (e = n.memoizedState, e !== null && (e = e.dehydrated, e !== null && (n = jb.bind(
        null,
        n
      ), Fb(e, n))));
      break;
    case 22:
      if (a = n.memoizedState !== null || Yt, !a) {
        t = t !== null && t.memoizedState !== null || Me, l = Yt;
        var i = Me;
        Yt = a, (Me = t) && !i ? Ht(
          e,
          n,
          (n.subtreeFlags & 8772) !== 0
        ) : Lt(e, n), Yt = l, Me = i;
      }
      break;
    case 30:
      break;
    default:
      Lt(e, n);
  }
}
function $h(e) {
  var t = e.alternate;
  t !== null && (e.alternate = null, $h(t)), e.child = null, e.deletions = null, e.sibling = null, e.tag === 5 && (t = e.stateNode, t !== null && Tc(t)), e.stateNode = null, e.return = null, e.dependencies = null, e.memoizedProps = null, e.memoizedState = null, e.pendingProps = null, e.stateNode = null, e.updateQueue = null;
}
var be = null, We = !1;
function Vt(e, t, n) {
  for (n = n.child; n !== null; )
    Ph(e, t, n), n = n.sibling;
}
function Ph(e, t, n) {
  if (st && typeof st.onCommitFiberUnmount == "function")
    try {
      st.onCommitFiberUnmount(mi, n);
    } catch {
    }
  switch (n.tag) {
    case 26:
      Me || Tt(n, t), Vt(
        e,
        t,
        n
      ), n.memoizedState ? n.memoizedState.count-- : n.stateNode && (n = n.stateNode, n.parentNode.removeChild(n));
      break;
    case 27:
      Me || Tt(n, t);
      var a = be, l = We;
      Yn(n.type) && (be = n.stateNode, We = !1), Vt(
        e,
        t,
        n
      ), Il(n.stateNode), be = a, We = l;
      break;
    case 5:
      Me || Tt(n, t);
    case 6:
      if (a = be, l = We, be = null, Vt(
        e,
        t,
        n
      ), be = a, We = l, be !== null)
        if (We)
          try {
            (be.nodeType === 9 ? be.body : be.nodeName === "HTML" ? be.ownerDocument.body : be).removeChild(n.stateNode);
          } catch (i) {
            se(
              n,
              t,
              i
            );
          }
        else
          try {
            be.removeChild(n.stateNode);
          } catch (i) {
            se(
              n,
              t,
              i
            );
          }
      break;
    case 18:
      be !== null && (We ? (e = be, Pf(
        e.nodeType === 9 ? e.body : e.nodeName === "HTML" ? e.ownerDocument.body : e,
        n.stateNode
      ), al(e)) : Pf(be, n.stateNode));
      break;
    case 4:
      a = be, l = We, be = n.stateNode.containerInfo, We = !0, Vt(
        e,
        t,
        n
      ), be = a, We = l;
      break;
    case 0:
    case 11:
    case 14:
    case 15:
      Ln(2, n, t), Me || Ln(4, n, t), Vt(
        e,
        t,
        n
      );
      break;
    case 1:
      Me || (Tt(n, t), a = n.stateNode, typeof a.componentWillUnmount == "function" && Fh(
        n,
        t,
        a
      )), Vt(
        e,
        t,
        n
      );
      break;
    case 21:
      Vt(
        e,
        t,
        n
      );
      break;
    case 22:
      Me = (a = Me) || n.memoizedState !== null, Vt(
        e,
        t,
        n
      ), Me = a;
      break;
    default:
      Vt(
        e,
        t,
        n
      );
  }
}
function eg(e, t) {
  if (t.memoizedState === null && (e = t.alternate, e !== null && (e = e.memoizedState, e !== null))) {
    e = e.dehydrated;
    try {
      al(e);
    } catch (n) {
      se(t, t.return, n);
    }
  }
}
function tg(e, t) {
  if (t.memoizedState === null && (e = t.alternate, e !== null && (e = e.memoizedState, e !== null && (e = e.dehydrated, e !== null))))
    try {
      al(e);
    } catch (n) {
      se(t, t.return, n);
    }
}
function bb(e) {
  switch (e.tag) {
    case 31:
    case 13:
    case 19:
      var t = e.stateNode;
      return t === null && (t = e.stateNode = new Hf()), t;
    case 22:
      return e = e.stateNode, t = e._retryCache, t === null && (t = e._retryCache = new Hf()), t;
    default:
      throw Error(_(435, e.tag));
  }
}
function Hi(e, t) {
  var n = bb(e);
  t.forEach(function(a) {
    if (!n.has(a)) {
      n.add(a);
      var l = Mb.bind(null, e, a);
      a.then(l, l);
    }
  });
}
function Je(e, t) {
  var n = t.deletions;
  if (n !== null)
    for (var a = 0; a < n.length; a++) {
      var l = n[a], i = e, o = t, s = o;
      e: for (; s !== null; ) {
        switch (s.tag) {
          case 27:
            if (Yn(s.type)) {
              be = s.stateNode, We = !1;
              break e;
            }
            break;
          case 5:
            be = s.stateNode, We = !1;
            break e;
          case 3:
          case 4:
            be = s.stateNode.containerInfo, We = !0;
            break e;
        }
        s = s.return;
      }
      if (be === null) throw Error(_(160));
      Ph(i, o, l), be = null, We = !1, i = l.alternate, i !== null && (i.return = null), l.return = null;
    }
  if (t.subtreeFlags & 13886)
    for (t = t.child; t !== null; )
      ng(t, e), t = t.sibling;
}
var At = null;
function ng(e, t) {
  var n = e.alternate, a = e.flags;
  switch (e.tag) {
    case 0:
    case 11:
    case 14:
    case 15:
      Je(t, e), Ie(e), a & 4 && (Ln(3, e, e.return), xi(3, e), Ln(5, e, e.return));
      break;
    case 1:
      Je(t, e), Ie(e), a & 512 && (Me || n === null || Tt(n, n.return)), a & 64 && Yt && (e = e.updateQueue, e !== null && (a = e.callbacks, a !== null && (n = e.shared.hiddenCallbacks, e.shared.hiddenCallbacks = n === null ? a : n.concat(a))));
      break;
    case 26:
      var l = At;
      if (Je(t, e), Ie(e), a & 512 && (Me || n === null || Tt(n, n.return)), a & 4) {
        var i = n !== null ? n.memoizedState : null;
        if (a = e.memoizedState, n === null)
          if (a === null)
            if (e.stateNode === null) {
              e: {
                a = e.type, n = e.memoizedProps, l = l.ownerDocument || l;
                t: switch (a) {
                  case "title":
                    i = l.getElementsByTagName("title")[0], (!i || i[vi] || i[Ge] || i.namespaceURI === "http://www.w3.org/2000/svg" || i.hasAttribute("itemprop")) && (i = l.createElement(a), l.head.insertBefore(
                      i,
                      l.querySelector("head > title")
                    )), Xe(i, a, n), i[Ge] = e, Ue(i), a = i;
                    break e;
                  case "link":
                    var o = od(
                      "link",
                      "href",
                      l
                    ).get(a + (n.href || ""));
                    if (o) {
                      for (var s = 0; s < o.length; s++)
                        if (i = o[s], i.getAttribute("href") === (n.href == null || n.href === "" ? null : n.href) && i.getAttribute("rel") === (n.rel == null ? null : n.rel) && i.getAttribute("title") === (n.title == null ? null : n.title) && i.getAttribute("crossorigin") === (n.crossOrigin == null ? null : n.crossOrigin)) {
                          o.splice(s, 1);
                          break t;
                        }
                    }
                    i = l.createElement(a), Xe(i, a, n), l.head.appendChild(i);
                    break;
                  case "meta":
                    if (o = od(
                      "meta",
                      "content",
                      l
                    ).get(a + (n.content || ""))) {
                      for (s = 0; s < o.length; s++)
                        if (i = o[s], i.getAttribute("content") === (n.content == null ? null : "" + n.content) && i.getAttribute("name") === (n.name == null ? null : n.name) && i.getAttribute("property") === (n.property == null ? null : n.property) && i.getAttribute("http-equiv") === (n.httpEquiv == null ? null : n.httpEquiv) && i.getAttribute("charset") === (n.charSet == null ? null : n.charSet)) {
                          o.splice(s, 1);
                          break t;
                        }
                    }
                    i = l.createElement(a), Xe(i, a, n), l.head.appendChild(i);
                    break;
                  default:
                    throw Error(_(468, a));
                }
                i[Ge] = e, Ue(i), a = i;
              }
              e.stateNode = a;
            } else
              sd(
                l,
                e.type,
                e.stateNode
              );
          else
            e.stateNode = id(
              l,
              a,
              e.memoizedProps
            );
        else
          i !== a ? (i === null ? n.stateNode !== null && (n = n.stateNode, n.parentNode.removeChild(n)) : i.count--, a === null ? sd(
            l,
            e.type,
            e.stateNode
          ) : id(
            l,
            a,
            e.memoizedProps
          )) : a === null && e.stateNode !== null && $s(
            e,
            e.memoizedProps,
            n.memoizedProps
          );
      }
      break;
    case 27:
      Je(t, e), Ie(e), a & 512 && (Me || n === null || Tt(n, n.return)), n !== null && a & 4 && $s(
        e,
        e.memoizedProps,
        n.memoizedProps
      );
      break;
    case 5:
      if (Je(t, e), Ie(e), a & 512 && (Me || n === null || Tt(n, n.return)), e.flags & 32) {
        l = e.stateNode;
        try {
          Ja(l, "");
        } catch (C) {
          se(e, e.return, C);
        }
      }
      a & 4 && e.stateNode != null && (l = e.memoizedProps, $s(
        e,
        l,
        n !== null ? n.memoizedProps : l
      )), a & 1024 && (er = !0);
      break;
    case 6:
      if (Je(t, e), Ie(e), a & 4) {
        if (e.stateNode === null)
          throw Error(_(162));
        a = e.memoizedProps, n = e.stateNode;
        try {
          n.nodeValue = a;
        } catch (C) {
          se(e, e.return, C);
        }
      }
      break;
    case 3:
      if (ro = null, l = At, At = Vo(t.containerInfo), Je(t, e), At = l, Ie(e), a & 4 && n !== null && n.memoizedState.isDehydrated)
        try {
          al(t.containerInfo);
        } catch (C) {
          se(e, e.return, C);
        }
      er && (er = !1, ag(e));
      break;
    case 4:
      a = At, At = Vo(
        e.stateNode.containerInfo
      ), Je(t, e), Ie(e), At = a;
      break;
    case 12:
      Je(t, e), Ie(e);
      break;
    case 31:
      Je(t, e), Ie(e), a & 4 && (a = e.updateQueue, a !== null && (e.updateQueue = null, Hi(e, a)));
      break;
    case 13:
      Je(t, e), Ie(e), e.child.flags & 8192 && e.memoizedState !== null != (n !== null && n.memoizedState !== null) && (ds = ot()), a & 4 && (a = e.updateQueue, a !== null && (e.updateQueue = null, Hi(e, a)));
      break;
    case 22:
      l = e.memoizedState !== null;
      var c = n !== null && n.memoizedState !== null, u = Yt, m = Me;
      if (Yt = u || l, Me = m || c, Je(t, e), Me = m, Yt = u, Ie(e), a & 8192)
        e: for (t = e.stateNode, t._visibility = l ? t._visibility & -2 : t._visibility | 1, l && (n === null || c || Yt || Me || Wn(e)), n = null, t = e; ; ) {
          if (t.tag === 5 || t.tag === 26) {
            if (n === null) {
              c = n = t;
              try {
                if (i = c.stateNode, l)
                  o = i.style, typeof o.setProperty == "function" ? o.setProperty("display", "none", "important") : o.display = "none";
                else {
                  s = c.stateNode;
                  var g = c.memoizedProps.style, f = g != null && g.hasOwnProperty("display") ? g.display : null;
                  s.style.display = f == null || typeof f == "boolean" ? "" : ("" + f).trim();
                }
              } catch (C) {
                se(c, c.return, C);
              }
            }
          } else if (t.tag === 6) {
            if (n === null) {
              c = t;
              try {
                c.stateNode.nodeValue = l ? "" : c.memoizedProps;
              } catch (C) {
                se(c, c.return, C);
              }
            }
          } else if (t.tag === 18) {
            if (n === null) {
              c = t;
              try {
                var p = c.stateNode;
                l ? ed(p, !0) : ed(c.stateNode, !1);
              } catch (C) {
                se(c, c.return, C);
              }
            }
          } else if ((t.tag !== 22 && t.tag !== 23 || t.memoizedState === null || t === e) && t.child !== null) {
            t.child.return = t, t = t.child;
            continue;
          }
          if (t === e) break e;
          for (; t.sibling === null; ) {
            if (t.return === null || t.return === e) break e;
            n === t && (n = null), t = t.return;
          }
          n === t && (n = null), t.sibling.return = t.return, t = t.sibling;
        }
      a & 4 && (a = e.updateQueue, a !== null && (n = a.retryQueue, n !== null && (a.retryQueue = null, Hi(e, n))));
      break;
    case 19:
      Je(t, e), Ie(e), a & 4 && (a = e.updateQueue, a !== null && (e.updateQueue = null, Hi(e, a)));
      break;
    case 30:
      break;
    case 21:
      break;
    default:
      Je(t, e), Ie(e);
  }
}
function Ie(e) {
  var t = e.flags;
  if (t & 2) {
    try {
      for (var n, a = e.return; a !== null; ) {
        if (Jh(a)) {
          n = a;
          break;
        }
        a = a.return;
      }
      if (n == null) throw Error(_(160));
      switch (n.tag) {
        case 27:
          var l = n.stateNode, i = Ps(e);
          To(e, i, l);
          break;
        case 5:
          var o = n.stateNode;
          n.flags & 32 && (Ja(o, ""), n.flags &= -33);
          var s = Ps(e);
          To(e, s, o);
          break;
        case 3:
        case 4:
          var c = n.stateNode.containerInfo, u = Ps(e);
          Ir(
            e,
            u,
            c
          );
          break;
        default:
          throw Error(_(161));
      }
    } catch (m) {
      se(e, e.return, m);
    }
    e.flags &= -3;
  }
  t & 4096 && (e.flags &= -4097);
}
function ag(e) {
  if (e.subtreeFlags & 1024)
    for (e = e.child; e !== null; ) {
      var t = e;
      ag(t), t.tag === 5 && t.flags & 1024 && t.stateNode.reset(), e = e.sibling;
    }
}
function Lt(e, t) {
  if (t.subtreeFlags & 8772)
    for (t = t.child; t !== null; )
      Wh(e, t.alternate, t), t = t.sibling;
}
function Wn(e) {
  for (e = e.child; e !== null; ) {
    var t = e;
    switch (t.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        Ln(4, t, t.return), Wn(t);
        break;
      case 1:
        Tt(t, t.return);
        var n = t.stateNode;
        typeof n.componentWillUnmount == "function" && Fh(
          t,
          t.return,
          n
        ), Wn(t);
        break;
      case 27:
        Il(t.stateNode);
      case 26:
      case 5:
        Tt(t, t.return), Wn(t);
        break;
      case 22:
        t.memoizedState === null && Wn(t);
        break;
      case 30:
        Wn(t);
        break;
      default:
        Wn(t);
    }
    e = e.sibling;
  }
}
function Ht(e, t, n) {
  for (n = n && (t.subtreeFlags & 8772) !== 0, t = t.child; t !== null; ) {
    var a = t.alternate, l = e, i = t, o = i.flags;
    switch (i.tag) {
      case 0:
      case 11:
      case 15:
        Ht(
          l,
          i,
          n
        ), xi(4, i);
        break;
      case 1:
        if (Ht(
          l,
          i,
          n
        ), a = i, l = a.stateNode, typeof l.componentDidMount == "function")
          try {
            l.componentDidMount();
          } catch (u) {
            se(a, a.return, u);
          }
        if (a = i, l = a.updateQueue, l !== null) {
          var s = a.stateNode;
          try {
            var c = l.shared.hiddenCallbacks;
            if (c !== null)
              for (l.shared.hiddenCallbacks = null, l = 0; l < c.length; l++)
                eh(c[l], s);
          } catch (u) {
            se(a, a.return, u);
          }
        }
        n && o & 64 && Zh(i), Zl(i, i.return);
        break;
      case 27:
        Ih(i);
      case 26:
      case 5:
        Ht(
          l,
          i,
          n
        ), n && a === null && o & 4 && Kh(i), Zl(i, i.return);
        break;
      case 12:
        Ht(
          l,
          i,
          n
        );
        break;
      case 31:
        Ht(
          l,
          i,
          n
        ), n && o & 4 && eg(l, i);
        break;
      case 13:
        Ht(
          l,
          i,
          n
        ), n && o & 4 && tg(l, i);
        break;
      case 22:
        i.memoizedState === null && Ht(
          l,
          i,
          n
        ), Zl(i, i.return);
        break;
      case 30:
        break;
      default:
        Ht(
          l,
          i,
          n
        );
    }
    t = t.sibling;
  }
}
function su(e, t) {
  var n = null;
  e !== null && e.memoizedState !== null && e.memoizedState.cachePool !== null && (n = e.memoizedState.cachePool.pool), e = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (e = t.memoizedState.cachePool.pool), e !== n && (e != null && e.refCount++, n != null && yi(n));
}
function ru(e, t) {
  e = null, t.alternate !== null && (e = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== e && (t.refCount++, e != null && yi(e));
}
function wt(e, t, n, a) {
  if (t.subtreeFlags & 10256)
    for (t = t.child; t !== null; )
      lg(
        e,
        t,
        n,
        a
      ), t = t.sibling;
}
function lg(e, t, n, a) {
  var l = t.flags;
  switch (t.tag) {
    case 0:
    case 11:
    case 15:
      wt(
        e,
        t,
        n,
        a
      ), l & 2048 && xi(9, t);
      break;
    case 1:
      wt(
        e,
        t,
        n,
        a
      );
      break;
    case 3:
      wt(
        e,
        t,
        n,
        a
      ), l & 2048 && (e = null, t.alternate !== null && (e = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== e && (t.refCount++, e != null && yi(e)));
      break;
    case 12:
      if (l & 2048) {
        wt(
          e,
          t,
          n,
          a
        ), e = t.stateNode;
        try {
          var i = t.memoizedProps, o = i.id, s = i.onPostCommit;
          typeof s == "function" && s(
            o,
            t.alternate === null ? "mount" : "update",
            e.passiveEffectDuration,
            -0
          );
        } catch (c) {
          se(t, t.return, c);
        }
      } else
        wt(
          e,
          t,
          n,
          a
        );
      break;
    case 31:
      wt(
        e,
        t,
        n,
        a
      );
      break;
    case 13:
      wt(
        e,
        t,
        n,
        a
      );
      break;
    case 23:
      break;
    case 22:
      i = t.stateNode, o = t.alternate, t.memoizedState !== null ? i._visibility & 2 ? wt(
        e,
        t,
        n,
        a
      ) : Fl(e, t) : i._visibility & 2 ? wt(
        e,
        t,
        n,
        a
      ) : (i._visibility |= 2, wa(
        e,
        t,
        n,
        a,
        (t.subtreeFlags & 10256) !== 0 || !1
      )), l & 2048 && su(o, t);
      break;
    case 24:
      wt(
        e,
        t,
        n,
        a
      ), l & 2048 && ru(t.alternate, t);
      break;
    default:
      wt(
        e,
        t,
        n,
        a
      );
  }
}
function wa(e, t, n, a, l) {
  for (l = l && ((t.subtreeFlags & 10256) !== 0 || !1), t = t.child; t !== null; ) {
    var i = e, o = t, s = n, c = a, u = o.flags;
    switch (o.tag) {
      case 0:
      case 11:
      case 15:
        wa(
          i,
          o,
          s,
          c,
          l
        ), xi(8, o);
        break;
      case 23:
        break;
      case 22:
        var m = o.stateNode;
        o.memoizedState !== null ? m._visibility & 2 ? wa(
          i,
          o,
          s,
          c,
          l
        ) : Fl(
          i,
          o
        ) : (m._visibility |= 2, wa(
          i,
          o,
          s,
          c,
          l
        )), l && u & 2048 && su(
          o.alternate,
          o
        );
        break;
      case 24:
        wa(
          i,
          o,
          s,
          c,
          l
        ), l && u & 2048 && ru(o.alternate, o);
        break;
      default:
        wa(
          i,
          o,
          s,
          c,
          l
        );
    }
    t = t.sibling;
  }
}
function Fl(e, t) {
  if (t.subtreeFlags & 10256)
    for (t = t.child; t !== null; ) {
      var n = e, a = t, l = a.flags;
      switch (a.tag) {
        case 22:
          Fl(n, a), l & 2048 && su(
            a.alternate,
            a
          );
          break;
        case 24:
          Fl(n, a), l & 2048 && ru(a.alternate, a);
          break;
        default:
          Fl(n, a);
      }
      t = t.sibling;
    }
}
var Ul = 8192;
function ya(e, t, n) {
  if (e.subtreeFlags & Ul)
    for (e = e.child; e !== null; )
      ig(
        e,
        t,
        n
      ), e = e.sibling;
}
function ig(e, t, n) {
  switch (e.tag) {
    case 26:
      ya(
        e,
        t,
        n
      ), e.flags & Ul && e.memoizedState !== null && i1(
        n,
        At,
        e.memoizedState,
        e.memoizedProps
      );
      break;
    case 5:
      ya(
        e,
        t,
        n
      );
      break;
    case 3:
    case 4:
      var a = At;
      At = Vo(e.stateNode.containerInfo), ya(
        e,
        t,
        n
      ), At = a;
      break;
    case 22:
      e.memoizedState === null && (a = e.alternate, a !== null && a.memoizedState !== null ? (a = Ul, Ul = 16777216, ya(
        e,
        t,
        n
      ), Ul = a) : ya(
        e,
        t,
        n
      ));
      break;
    default:
      ya(
        e,
        t,
        n
      );
  }
}
function og(e) {
  var t = e.alternate;
  if (t !== null && (e = t.child, e !== null)) {
    t.child = null;
    do
      t = e.sibling, e.sibling = null, e = t;
    while (e !== null);
  }
}
function Ml(e) {
  var t = e.deletions;
  if (e.flags & 16) {
    if (t !== null)
      for (var n = 0; n < t.length; n++) {
        var a = t[n];
        ke = a, rg(
          a,
          e
        );
      }
    og(e);
  }
  if (e.subtreeFlags & 10256)
    for (e = e.child; e !== null; )
      sg(e), e = e.sibling;
}
function sg(e) {
  switch (e.tag) {
    case 0:
    case 11:
    case 15:
      Ml(e), e.flags & 2048 && Ln(9, e, e.return);
      break;
    case 3:
      Ml(e);
      break;
    case 12:
      Ml(e);
      break;
    case 22:
      var t = e.stateNode;
      e.memoizedState !== null && t._visibility & 2 && (e.return === null || e.return.tag !== 13) ? (t._visibility &= -3, oo(e)) : Ml(e);
      break;
    default:
      Ml(e);
  }
}
function oo(e) {
  var t = e.deletions;
  if (e.flags & 16) {
    if (t !== null)
      for (var n = 0; n < t.length; n++) {
        var a = t[n];
        ke = a, rg(
          a,
          e
        );
      }
    og(e);
  }
  for (e = e.child; e !== null; ) {
    switch (t = e, t.tag) {
      case 0:
      case 11:
      case 15:
        Ln(8, t, t.return), oo(t);
        break;
      case 22:
        n = t.stateNode, n._visibility & 2 && (n._visibility &= -3, oo(t));
        break;
      default:
        oo(t);
    }
    e = e.sibling;
  }
}
function rg(e, t) {
  for (; ke !== null; ) {
    var n = ke;
    switch (n.tag) {
      case 0:
      case 11:
      case 15:
        Ln(8, n, t);
        break;
      case 23:
      case 22:
        if (n.memoizedState !== null && n.memoizedState.cachePool !== null) {
          var a = n.memoizedState.cachePool.pool;
          a != null && a.refCount++;
        }
        break;
      case 24:
        yi(n.memoizedState.cache);
    }
    if (a = n.child, a !== null) a.return = n, ke = a;
    else
      e: for (n = e; ke !== null; ) {
        a = ke;
        var l = a.sibling, i = a.return;
        if ($h(a), a === n) {
          ke = null;
          break e;
        }
        if (l !== null) {
          l.return = i, ke = l;
          break e;
        }
        ke = i;
      }
  }
}
var xb = {
  getCacheForType: function(e) {
    var t = qe(Te), n = t.data.get(e);
    return n === void 0 && (n = e(), t.data.set(e, n)), n;
  },
  cacheSignal: function() {
    return qe(Te).controller.signal;
  }
}, Sb = typeof WeakMap == "function" ? WeakMap : Map, ae = 0, fe = null, $ = null, P = 0, oe = 0, nt = null, Cn = !1, fl = !1, cu = !1, tn = 0, Ce = 0, Bn = 0, aa = 0, uu = 0, it = 0, Pa = 0, Kl = null, $e = null, Wr = !1, ds = 0, cg = 0, Do = 1 / 0, _o = null, Dn = null, ze = 0, _n = null, el = null, Kt = 0, $r = 0, Pr = null, ug = null, Jl = 0, ec = null;
function ct() {
  return ae & 2 && P !== 0 ? P & -P : G.T !== null ? du() : bm();
}
function fg() {
  if (it === 0)
    if (!(P & 536870912) || ee) {
      var e = Oi;
      Oi <<= 1, !(Oi & 3932160) && (Oi = 262144), it = e;
    } else it = 536870912;
  return e = ft.current, e !== null && (e.flags |= 32), it;
}
function Pe(e, t, n) {
  (e === fe && (oe === 2 || oe === 9) || e.cancelPendingCommit !== null) && (tl(e, 0), wn(
    e,
    P,
    it,
    !1
  )), gi(e, n), (!(ae & 2) || e !== fe) && (e === fe && (!(ae & 2) && (aa |= n), Ce === 4 && wn(
    e,
    P,
    it,
    !1
  )), Ot(e));
}
function dg(e, t, n) {
  if (ae & 6) throw Error(_(327));
  var a = !n && (t & 127) === 0 && (t & e.expiredLanes) === 0 || hi(e, t), l = a ? Ab(e, t) : tr(e, t, !0), i = a;
  do {
    if (l === 0) {
      fl && !a && wn(e, t, 0, !1);
      break;
    } else {
      if (n = e.current.alternate, i && !Cb(n)) {
        l = tr(e, t, !1), i = !1;
        continue;
      }
      if (l === 2) {
        if (i = t, e.errorRecoveryDisabledLanes & i)
          var o = 0;
        else
          o = e.pendingLanes & -536870913, o = o !== 0 ? o : o & 536870912 ? 536870912 : 0;
        if (o !== 0) {
          t = o;
          e: {
            var s = e;
            l = Kl;
            var c = s.current.memoizedState.isDehydrated;
            if (c && (tl(s, o).flags |= 256), o = tr(
              s,
              o,
              !1
            ), o !== 2) {
              if (cu && !c) {
                s.errorRecoveryDisabledLanes |= i, aa |= i, l = 4;
                break e;
              }
              i = $e, $e = l, i !== null && ($e === null ? $e = i : $e.push.apply(
                $e,
                i
              ));
            }
            l = o;
          }
          if (i = !1, l !== 2) continue;
        }
      }
      if (l === 1) {
        tl(e, 0), wn(e, t, 0, !0);
        break;
      }
      e: {
        switch (a = e, i = l, i) {
          case 0:
          case 1:
            throw Error(_(345));
          case 4:
            if ((t & 4194048) !== t) break;
          case 6:
            wn(
              a,
              t,
              it,
              !Cn
            );
            break e;
          case 2:
            $e = null;
            break;
          case 3:
          case 5:
            break;
          default:
            throw Error(_(329));
        }
        if ((t & 62914560) === t && (l = ds + 300 - ot(), 10 < l)) {
          if (wn(
            a,
            t,
            it,
            !Cn
          ), ts(a, 0, !0) !== 0) break e;
          Kt = t, a.timeoutHandle = Og(
            Gf.bind(
              null,
              a,
              n,
              $e,
              _o,
              Wr,
              t,
              it,
              aa,
              Pa,
              Cn,
              i,
              "Throttled",
              -0,
              0
            ),
            l
          );
          break e;
        }
        Gf(
          a,
          n,
          $e,
          _o,
          Wr,
          t,
          it,
          aa,
          Pa,
          Cn,
          i,
          null,
          -0,
          0
        );
      }
    }
    break;
  } while (!0);
  Ot(e);
}
function Gf(e, t, n, a, l, i, o, s, c, u, m, g, f, p) {
  if (e.timeoutHandle = -1, g = t.subtreeFlags, g & 8192 || (g & 16785408) === 16785408) {
    g = {
      stylesheets: null,
      count: 0,
      imgCount: 0,
      imgBytes: 0,
      suspenseyImages: [],
      waitingForImages: !0,
      waitingForViewTransition: !1,
      unsuspend: Xt
    }, ig(
      t,
      i,
      g
    );
    var C = (i & 62914560) === i ? ds - ot() : (i & 4194048) === i ? cg - ot() : 0;
    if (C = o1(
      g,
      C
    ), C !== null) {
      Kt = i, e.cancelPendingCommit = C(
        qf.bind(
          null,
          e,
          t,
          i,
          n,
          a,
          l,
          o,
          s,
          c,
          m,
          g,
          null,
          f,
          p
        )
      ), wn(e, i, o, !u);
      return;
    }
  }
  qf(
    e,
    t,
    i,
    n,
    a,
    l,
    o,
    s,
    c
  );
}
function Cb(e) {
  for (var t = e; ; ) {
    var n = t.tag;
    if ((n === 0 || n === 11 || n === 15) && t.flags & 16384 && (n = t.updateQueue, n !== null && (n = n.stores, n !== null)))
      for (var a = 0; a < n.length; a++) {
        var l = n[a], i = l.getSnapshot;
        l = l.value;
        try {
          if (!ut(i(), l)) return !1;
        } catch {
          return !1;
        }
      }
    if (n = t.child, t.subtreeFlags & 16384 && n !== null)
      n.return = t, t = n;
    else {
      if (t === e) break;
      for (; t.sibling === null; ) {
        if (t.return === null || t.return === e) return !0;
        t = t.return;
      }
      t.sibling.return = t.return, t = t.sibling;
    }
  }
  return !0;
}
function wn(e, t, n, a) {
  t &= ~uu, t &= ~aa, e.suspendedLanes |= t, e.pingedLanes &= ~t, a && (e.warmLanes |= t), a = e.expirationTimes;
  for (var l = t; 0 < l; ) {
    var i = 31 - rt(l), o = 1 << i;
    a[i] = -1, l &= ~o;
  }
  n !== 0 && vm(e, n, t);
}
function ms() {
  return ae & 6 ? !0 : (Si(0), !1);
}
function fu() {
  if ($ !== null) {
    if (oe === 0)
      var e = $.return;
    else
      e = $, Qt = ha = null, Ic(e), qa = null, ai = 0, e = $;
    for (; e !== null; )
      Qh(e.alternate, e), e = e.return;
    $ = null;
  }
}
function tl(e, t) {
  var n = e.timeoutHandle;
  n !== -1 && (e.timeoutHandle = -1, Yb(n)), n = e.cancelPendingCommit, n !== null && (e.cancelPendingCommit = null, n()), Kt = 0, fu(), fe = e, $ = n = Zt(e.current, null), P = t, oe = 0, nt = null, Cn = !1, fl = hi(e, t), cu = !1, Pa = it = uu = aa = Bn = Ce = 0, $e = Kl = null, Wr = !1, t & 8 && (t |= t & 32);
  var a = e.entangledLanes;
  if (a !== 0)
    for (e = e.entanglements, a &= t; 0 < a; ) {
      var l = 31 - rt(a), i = 1 << l;
      t |= e[l], a &= ~i;
    }
  return tn = t, is(), n;
}
function mg(e, t) {
  X = null, G.H = ii, t === ul || t === ss ? (t = bf(), oe = 3) : t === qc ? (t = bf(), oe = 4) : oe = t === iu ? 8 : t !== null && typeof t == "object" && typeof t.then == "function" ? 6 : 1, nt = t, $ === null && (Ce = 1, jo(
    e,
    pt(t, e.current)
  ));
}
function hg() {
  var e = ft.current;
  return e === null ? !0 : (P & 4194048) === P ? bt === null : (P & 62914560) === P || P & 536870912 ? e === bt : !1;
}
function gg() {
  var e = G.H;
  return G.H = ii, e === null ? ii : e;
}
function vg() {
  var e = G.A;
  return G.A = xb, e;
}
function Oo() {
  Ce = 4, Cn || (P & 4194048) !== P && ft.current !== null || (fl = !0), !(Bn & 134217727) && !(aa & 134217727) || fe === null || wn(
    fe,
    P,
    it,
    !1
  );
}
function tr(e, t, n) {
  var a = ae;
  ae |= 2;
  var l = gg(), i = vg();
  (fe !== e || P !== t) && (_o = null, tl(e, t)), t = !1;
  var o = Ce;
  e: do
    try {
      if (oe !== 0 && $ !== null) {
        var s = $, c = nt;
        switch (oe) {
          case 8:
            fu(), o = 6;
            break e;
          case 3:
          case 2:
          case 9:
          case 6:
            ft.current === null && (t = !0);
            var u = oe;
            if (oe = 0, nt = null, Ua(e, s, c, u), n && fl) {
              o = 0;
              break e;
            }
            break;
          default:
            u = oe, oe = 0, nt = null, Ua(e, s, c, u);
        }
      }
      wb(), o = Ce;
      break;
    } catch (m) {
      mg(e, m);
    }
  while (!0);
  return t && e.shellSuspendCounter++, Qt = ha = null, ae = a, G.H = l, G.A = i, $ === null && (fe = null, P = 0, is()), o;
}
function wb() {
  for (; $ !== null; ) pg($);
}
function Ab(e, t) {
  var n = ae;
  ae |= 2;
  var a = gg(), l = vg();
  fe !== e || P !== t ? (_o = null, Do = ot() + 500, tl(e, t)) : fl = hi(
    e,
    t
  );
  e: do
    try {
      if (oe !== 0 && $ !== null) {
        t = $;
        var i = nt;
        t: switch (oe) {
          case 1:
            oe = 0, nt = null, Ua(e, t, i, 1);
            break;
          case 2:
          case 9:
            if (yf(i)) {
              oe = 0, nt = null, Yf(t);
              break;
            }
            t = function() {
              oe !== 2 && oe !== 9 || fe !== e || (oe = 7), Ot(e);
            }, i.then(t, t);
            break e;
          case 3:
            oe = 7;
            break e;
          case 4:
            oe = 5;
            break e;
          case 7:
            yf(i) ? (oe = 0, nt = null, Yf(t)) : (oe = 0, nt = null, Ua(e, t, i, 7));
            break;
          case 5:
            var o = null;
            switch ($.tag) {
              case 26:
                o = $.memoizedState;
              case 5:
              case 27:
                var s = $;
                if (o ? Vg(o) : s.stateNode.complete) {
                  oe = 0, nt = null;
                  var c = s.sibling;
                  if (c !== null) $ = c;
                  else {
                    var u = s.return;
                    u !== null ? ($ = u, hs(u)) : $ = null;
                  }
                  break t;
                }
            }
            oe = 0, nt = null, Ua(e, t, i, 5);
            break;
          case 6:
            oe = 0, nt = null, Ua(e, t, i, 6);
            break;
          case 8:
            fu(), Ce = 6;
            break e;
          default:
            throw Error(_(462));
        }
      }
      Nb();
      break;
    } catch (m) {
      mg(e, m);
    }
  while (!0);
  return Qt = ha = null, G.H = a, G.A = l, ae = n, $ !== null ? 0 : (fe = null, P = 0, is(), Ce);
}
function Nb() {
  for (; $ !== null && !Ky(); )
    pg($);
}
function pg(e) {
  var t = Xh(e.alternate, e, tn);
  e.memoizedProps = e.pendingProps, t === null ? hs(e) : $ = t;
}
function Yf(e) {
  var t = e, n = t.alternate;
  switch (t.tag) {
    case 15:
    case 0:
      t = kf(
        n,
        t,
        t.pendingProps,
        t.type,
        void 0,
        P
      );
      break;
    case 11:
      t = kf(
        n,
        t,
        t.pendingProps,
        t.type.render,
        t.ref,
        P
      );
      break;
    case 5:
      Ic(t);
    default:
      Qh(n, t), t = $ = Qm(t, tn), t = Xh(n, t, tn);
  }
  e.memoizedProps = e.pendingProps, t === null ? hs(e) : $ = t;
}
function Ua(e, t, n, a) {
  Qt = ha = null, Ic(t), qa = null, ai = 0;
  var l = t.return;
  try {
    if (mb(
      e,
      l,
      t,
      n,
      P
    )) {
      Ce = 1, jo(
        e,
        pt(n, e.current)
      ), $ = null;
      return;
    }
  } catch (i) {
    if (l !== null) throw $ = l, i;
    Ce = 1, jo(
      e,
      pt(n, e.current)
    ), $ = null;
    return;
  }
  t.flags & 32768 ? (ee || a === 1 ? e = !0 : fl || P & 536870912 ? e = !1 : (Cn = e = !0, (a === 2 || a === 9 || a === 3 || a === 6) && (a = ft.current, a !== null && a.tag === 13 && (a.flags |= 16384))), yg(t, e)) : hs(t);
}
function hs(e) {
  var t = e;
  do {
    if (t.flags & 32768) {
      yg(
        t,
        Cn
      );
      return;
    }
    e = t.return;
    var n = vb(
      t.alternate,
      t,
      tn
    );
    if (n !== null) {
      $ = n;
      return;
    }
    if (t = t.sibling, t !== null) {
      $ = t;
      return;
    }
    $ = t = e;
  } while (t !== null);
  Ce === 0 && (Ce = 5);
}
function yg(e, t) {
  do {
    var n = pb(e.alternate, e);
    if (n !== null) {
      n.flags &= 32767, $ = n;
      return;
    }
    if (n = e.return, n !== null && (n.flags |= 32768, n.subtreeFlags = 0, n.deletions = null), !t && (e = e.sibling, e !== null)) {
      $ = e;
      return;
    }
    $ = e = n;
  } while (e !== null);
  Ce = 6, $ = null;
}
function qf(e, t, n, a, l, i, o, s, c) {
  e.cancelPendingCommit = null;
  do
    gs();
  while (ze !== 0);
  if (ae & 6) throw Error(_(327));
  if (t !== null) {
    if (t === e.current) throw Error(_(177));
    if (i = t.lanes | t.childLanes, i |= Uc, l0(
      e,
      n,
      i,
      o,
      s,
      c
    ), e === fe && ($ = fe = null, P = 0), el = t, _n = e, Kt = n, $r = i, Pr = l, ug = a, t.subtreeFlags & 10256 || t.flags & 10256 ? (e.callbackNode = null, e.callbackPriority = 0, Tb(vo, function() {
      return wg(), null;
    })) : (e.callbackNode = null, e.callbackPriority = 0), a = (t.flags & 13878) !== 0, t.subtreeFlags & 13878 || a) {
      a = G.T, G.T = null, l = le.p, le.p = 2, o = ae, ae |= 4;
      try {
        yb(e, t, n);
      } finally {
        ae = o, le.p = l, G.T = a;
      }
    }
    ze = 1, bg(), xg(), Sg();
  }
}
function bg() {
  if (ze === 1) {
    ze = 0;
    var e = _n, t = el, n = (t.flags & 13878) !== 0;
    if (t.subtreeFlags & 13878 || n) {
      n = G.T, G.T = null;
      var a = le.p;
      le.p = 2;
      var l = ae;
      ae |= 4;
      try {
        ng(t, e);
        var i = lc, o = Vm(e.containerInfo), s = i.focusedElem, c = i.selectionRange;
        if (o !== s && s && s.ownerDocument && Um(
          s.ownerDocument.documentElement,
          s
        )) {
          if (c !== null && kc(s)) {
            var u = c.start, m = c.end;
            if (m === void 0 && (m = u), "selectionStart" in s)
              s.selectionStart = u, s.selectionEnd = Math.min(
                m,
                s.value.length
              );
            else {
              var g = s.ownerDocument || document, f = g && g.defaultView || window;
              if (f.getSelection) {
                var p = f.getSelection(), C = s.textContent.length, x = Math.min(c.start, C), S = c.end === void 0 ? x : Math.min(c.end, C);
                !p.extend && x > S && (o = S, S = x, x = o);
                var h = ff(
                  s,
                  x
                ), d = ff(
                  s,
                  S
                );
                if (h && d && (p.rangeCount !== 1 || p.anchorNode !== h.node || p.anchorOffset !== h.offset || p.focusNode !== d.node || p.focusOffset !== d.offset)) {
                  var y = g.createRange();
                  y.setStart(h.node, h.offset), p.removeAllRanges(), x > S ? (p.addRange(y), p.extend(d.node, d.offset)) : (y.setEnd(d.node, d.offset), p.addRange(y));
                }
              }
            }
          }
          for (g = [], p = s; p = p.parentNode; )
            p.nodeType === 1 && g.push({
              element: p,
              left: p.scrollLeft,
              top: p.scrollTop
            });
          for (typeof s.focus == "function" && s.focus(), s = 0; s < g.length; s++) {
            var b = g[s];
            b.element.scrollLeft = b.left, b.element.scrollTop = b.top;
          }
        }
        Ho = !!ac, lc = ac = null;
      } finally {
        ae = l, le.p = a, G.T = n;
      }
    }
    e.current = t, ze = 2;
  }
}
function xg() {
  if (ze === 2) {
    ze = 0;
    var e = _n, t = el, n = (t.flags & 8772) !== 0;
    if (t.subtreeFlags & 8772 || n) {
      n = G.T, G.T = null;
      var a = le.p;
      le.p = 2;
      var l = ae;
      ae |= 4;
      try {
        Wh(e, t.alternate, t);
      } finally {
        ae = l, le.p = a, G.T = n;
      }
    }
    ze = 3;
  }
}
function Sg() {
  if (ze === 4 || ze === 3) {
    ze = 0, Jy();
    var e = _n, t = el, n = Kt, a = ug;
    t.subtreeFlags & 10256 || t.flags & 10256 ? ze = 5 : (ze = 0, el = _n = null, Cg(e, e.pendingLanes));
    var l = e.pendingLanes;
    if (l === 0 && (Dn = null), Mc(n), t = t.stateNode, st && typeof st.onCommitFiberRoot == "function")
      try {
        st.onCommitFiberRoot(
          mi,
          t,
          void 0,
          (t.current.flags & 128) === 128
        );
      } catch {
      }
    if (a !== null) {
      t = G.T, l = le.p, le.p = 2, G.T = null;
      try {
        for (var i = e.onRecoverableError, o = 0; o < a.length; o++) {
          var s = a[o];
          i(s.value, {
            componentStack: s.stack
          });
        }
      } finally {
        G.T = t, le.p = l;
      }
    }
    Kt & 3 && gs(), Ot(e), l = e.pendingLanes, n & 261930 && l & 42 ? e === ec ? Jl++ : (Jl = 0, ec = e) : Jl = 0, Si(0);
  }
}
function Cg(e, t) {
  (e.pooledCacheLanes &= t) === 0 && (t = e.pooledCache, t != null && (e.pooledCache = null, yi(t)));
}
function gs() {
  return bg(), xg(), Sg(), wg();
}
function wg() {
  if (ze !== 5) return !1;
  var e = _n, t = $r;
  $r = 0;
  var n = Mc(Kt), a = G.T, l = le.p;
  try {
    le.p = 32 > n ? 32 : n, G.T = null, n = Pr, Pr = null;
    var i = _n, o = Kt;
    if (ze = 0, el = _n = null, Kt = 0, ae & 6) throw Error(_(331));
    var s = ae;
    if (ae |= 4, sg(i.current), lg(
      i,
      i.current,
      o,
      n
    ), ae = s, Si(0, !1), st && typeof st.onPostCommitFiberRoot == "function")
      try {
        st.onPostCommitFiberRoot(mi, i);
      } catch {
      }
    return !0;
  } finally {
    le.p = l, G.T = a, Cg(e, t);
  }
}
function Xf(e, t, n) {
  t = pt(n, t), t = Fr(e.stateNode, t, 2), e = Tn(e, t, 2), e !== null && (gi(e, 2), Ot(e));
}
function se(e, t, n) {
  if (e.tag === 3)
    Xf(e, e, n);
  else
    for (; t !== null; ) {
      if (t.tag === 3) {
        Xf(
          t,
          e,
          n
        );
        break;
      } else if (t.tag === 1) {
        var a = t.stateNode;
        if (typeof t.type.getDerivedStateFromError == "function" || typeof a.componentDidCatch == "function" && (Dn === null || !Dn.has(a))) {
          e = pt(n, e), n = Lh(2), a = Tn(t, n, 2), a !== null && (Bh(
            n,
            a,
            t,
            e
          ), gi(a, 2), Ot(a));
          break;
        }
      }
      t = t.return;
    }
}
function nr(e, t, n) {
  var a = e.pingCache;
  if (a === null) {
    a = e.pingCache = new Sb();
    var l = /* @__PURE__ */ new Set();
    a.set(t, l);
  } else
    l = a.get(t), l === void 0 && (l = /* @__PURE__ */ new Set(), a.set(t, l));
  l.has(n) || (cu = !0, l.add(n), e = Eb.bind(null, e, t, n), t.then(e, e));
}
function Eb(e, t, n) {
  var a = e.pingCache;
  a !== null && a.delete(t), e.pingedLanes |= e.suspendedLanes & n, e.warmLanes &= ~n, fe === e && (P & n) === n && (Ce === 4 || Ce === 3 && (P & 62914560) === P && 300 > ot() - ds ? !(ae & 2) && tl(e, 0) : uu |= n, Pa === P && (Pa = 0)), Ot(e);
}
function Ag(e, t) {
  t === 0 && (t = gm()), e = ma(e, t), e !== null && (gi(e, t), Ot(e));
}
function jb(e) {
  var t = e.memoizedState, n = 0;
  t !== null && (n = t.retryLane), Ag(e, n);
}
function Mb(e, t) {
  var n = 0;
  switch (e.tag) {
    case 31:
    case 13:
      var a = e.stateNode, l = e.memoizedState;
      l !== null && (n = l.retryLane);
      break;
    case 19:
      a = e.stateNode;
      break;
    case 22:
      a = e.stateNode._retryCache;
      break;
    default:
      throw Error(_(314));
  }
  a !== null && a.delete(t), Ag(e, n);
}
function Tb(e, t) {
  return Ec(e, t);
}
var zo = null, Aa = null, tc = !1, Ro = !1, ar = !1, An = 0;
function Ot(e) {
  e !== Aa && e.next === null && (Aa === null ? zo = Aa = e : Aa = Aa.next = e), Ro = !0, tc || (tc = !0, _b());
}
function Si(e, t) {
  if (!ar && Ro) {
    ar = !0;
    do
      for (var n = !1, a = zo; a !== null; ) {
        if (e !== 0) {
          var l = a.pendingLanes;
          if (l === 0) var i = 0;
          else {
            var o = a.suspendedLanes, s = a.pingedLanes;
            i = (1 << 31 - rt(42 | e) + 1) - 1, i &= l & ~(o & ~s), i = i & 201326741 ? i & 201326741 | 1 : i ? i | 2 : 0;
          }
          i !== 0 && (n = !0, Qf(a, i));
        } else
          i = P, i = ts(
            a,
            a === fe ? i : 0,
            a.cancelPendingCommit !== null || a.timeoutHandle !== -1
          ), !(i & 3) || hi(a, i) || (n = !0, Qf(a, i));
        a = a.next;
      }
    while (n);
    ar = !1;
  }
}
function Db() {
  Ng();
}
function Ng() {
  Ro = tc = !1;
  var e = 0;
  An !== 0 && Gb() && (e = An);
  for (var t = ot(), n = null, a = zo; a !== null; ) {
    var l = a.next, i = Eg(a, t);
    i === 0 ? (a.next = null, n === null ? zo = l : n.next = l, l === null && (Aa = n)) : (n = a, (e !== 0 || i & 3) && (Ro = !0)), a = l;
  }
  ze !== 0 && ze !== 5 || Si(e), An !== 0 && (An = 0);
}
function Eg(e, t) {
  for (var n = e.suspendedLanes, a = e.pingedLanes, l = e.expirationTimes, i = e.pendingLanes & -62914561; 0 < i; ) {
    var o = 31 - rt(i), s = 1 << o, c = l[o];
    c === -1 ? (!(s & n) || s & a) && (l[o] = a0(s, t)) : c <= t && (e.expiredLanes |= s), i &= ~s;
  }
  if (t = fe, n = P, n = ts(
    e,
    e === t ? n : 0,
    e.cancelPendingCommit !== null || e.timeoutHandle !== -1
  ), a = e.callbackNode, n === 0 || e === t && (oe === 2 || oe === 9) || e.cancelPendingCommit !== null)
    return a !== null && a !== null && _s(a), e.callbackNode = null, e.callbackPriority = 0;
  if (!(n & 3) || hi(e, n)) {
    if (t = n & -n, t === e.callbackPriority) return t;
    switch (a !== null && _s(a), Mc(n)) {
      case 2:
      case 8:
        n = mm;
        break;
      case 32:
        n = vo;
        break;
      case 268435456:
        n = hm;
        break;
      default:
        n = vo;
    }
    return a = jg.bind(null, e), n = Ec(n, a), e.callbackPriority = t, e.callbackNode = n, t;
  }
  return a !== null && a !== null && _s(a), e.callbackPriority = 2, e.callbackNode = null, 2;
}
function jg(e, t) {
  if (ze !== 0 && ze !== 5)
    return e.callbackNode = null, e.callbackPriority = 0, null;
  var n = e.callbackNode;
  if (gs() && e.callbackNode !== n)
    return null;
  var a = P;
  return a = ts(
    e,
    e === fe ? a : 0,
    e.cancelPendingCommit !== null || e.timeoutHandle !== -1
  ), a === 0 ? null : (dg(e, a, t), Eg(e, ot()), e.callbackNode != null && e.callbackNode === n ? jg.bind(null, e) : null);
}
function Qf(e, t) {
  if (gs()) return null;
  dg(e, t, !0);
}
function _b() {
  qb(function() {
    ae & 6 ? Ec(
      dm,
      Db
    ) : Ng();
  });
}
function du() {
  if (An === 0) {
    var e = Ia;
    e === 0 && (e = _i, _i <<= 1, !(_i & 261888) && (_i = 256)), An = e;
  }
  return An;
}
function Zf(e) {
  return e == null || typeof e == "symbol" || typeof e == "boolean" ? null : typeof e == "function" ? e : Wi("" + e);
}
function Ff(e, t) {
  var n = t.ownerDocument.createElement("input");
  return n.name = t.name, n.value = t.value, e.id && n.setAttribute("form", e.id), t.parentNode.insertBefore(n, t), e = new FormData(e), n.parentNode.removeChild(n), e;
}
function Ob(e, t, n, a, l) {
  if (t === "submit" && n && n.stateNode === l) {
    var i = Zf(
      (l[et] || null).action
    ), o = a.submitter;
    o && (t = (t = o[et] || null) ? Zf(t.formAction) : o.getAttribute("formAction"), t !== null && (i = t, o = null));
    var s = new ns(
      "action",
      "action",
      null,
      a,
      l
    );
    e.push({
      event: s,
      listeners: [
        {
          instance: null,
          listener: function() {
            if (a.defaultPrevented) {
              if (An !== 0) {
                var c = o ? Ff(l, o) : new FormData(l);
                Qr(
                  n,
                  {
                    pending: !0,
                    data: c,
                    method: l.method,
                    action: i
                  },
                  null,
                  c
                );
              }
            } else
              typeof i == "function" && (s.preventDefault(), c = o ? Ff(l, o) : new FormData(l), Qr(
                n,
                {
                  pending: !0,
                  data: c,
                  method: l.method,
                  action: i
                },
                i,
                c
              ));
          },
          currentTarget: l
        }
      ]
    });
  }
}
for (var lr = 0; lr < zr.length; lr++) {
  var ir = zr[lr], zb = ir.toLowerCase(), Rb = ir[0].toUpperCase() + ir.slice(1);
  Nt(
    zb,
    "on" + Rb
  );
}
Nt(Bm, "onAnimationEnd");
Nt(Hm, "onAnimationIteration");
Nt(Gm, "onAnimationStart");
Nt("dblclick", "onDoubleClick");
Nt("focusin", "onFocus");
Nt("focusout", "onBlur");
Nt(I0, "onTransitionRun");
Nt(W0, "onTransitionStart");
Nt($0, "onTransitionCancel");
Nt(Ym, "onTransitionEnd");
Ka("onMouseEnter", ["mouseout", "mouseover"]);
Ka("onMouseLeave", ["mouseout", "mouseover"]);
Ka("onPointerEnter", ["pointerout", "pointerover"]);
Ka("onPointerLeave", ["pointerout", "pointerover"]);
ua(
  "onChange",
  "change click focusin focusout input keydown keyup selectionchange".split(" ")
);
ua(
  "onSelect",
  "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(
    " "
  )
);
ua("onBeforeInput", [
  "compositionend",
  "keypress",
  "textInput",
  "paste"
]);
ua(
  "onCompositionEnd",
  "compositionend focusout keydown keypress keyup mousedown".split(" ")
);
ua(
  "onCompositionStart",
  "compositionstart focusout keydown keypress keyup mousedown".split(" ")
);
ua(
  "onCompositionUpdate",
  "compositionupdate focusout keydown keypress keyup mousedown".split(" ")
);
var oi = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
  " "
), kb = new Set(
  "beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(oi)
);
function Mg(e, t) {
  t = (t & 4) !== 0;
  for (var n = 0; n < e.length; n++) {
    var a = e[n], l = a.event;
    a = a.listeners;
    e: {
      var i = void 0;
      if (t)
        for (var o = a.length - 1; 0 <= o; o--) {
          var s = a[o], c = s.instance, u = s.currentTarget;
          if (s = s.listener, c !== i && l.isPropagationStopped())
            break e;
          i = s, l.currentTarget = u;
          try {
            i(l);
          } catch (m) {
            yo(m);
          }
          l.currentTarget = null, i = c;
        }
      else
        for (o = 0; o < a.length; o++) {
          if (s = a[o], c = s.instance, u = s.currentTarget, s = s.listener, c !== i && l.isPropagationStopped())
            break e;
          i = s, l.currentTarget = u;
          try {
            i(l);
          } catch (m) {
            yo(m);
          }
          l.currentTarget = null, i = c;
        }
    }
  }
}
function W(e, t) {
  var n = t[Nr];
  n === void 0 && (n = t[Nr] = /* @__PURE__ */ new Set());
  var a = e + "__bubble";
  n.has(a) || (Tg(t, e, 2, !1), n.add(a));
}
function or(e, t, n) {
  var a = 0;
  t && (a |= 4), Tg(
    n,
    e,
    a,
    t
  );
}
var Gi = "_reactListening" + Math.random().toString(36).slice(2);
function mu(e) {
  if (!e[Gi]) {
    e[Gi] = !0, xm.forEach(function(n) {
      n !== "selectionchange" && (kb.has(n) || or(n, !1, e), or(n, !0, e));
    });
    var t = e.nodeType === 9 ? e : e.ownerDocument;
    t === null || t[Gi] || (t[Gi] = !0, or("selectionchange", !1, t));
  }
}
function Tg(e, t, n, a) {
  switch (Yg(t)) {
    case 2:
      var l = c1;
      break;
    case 8:
      l = u1;
      break;
    default:
      l = pu;
  }
  n = l.bind(
    null,
    t,
    n,
    e
  ), l = void 0, !Dr || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (l = !0), a ? l !== void 0 ? e.addEventListener(t, n, {
    capture: !0,
    passive: l
  }) : e.addEventListener(t, n, !0) : l !== void 0 ? e.addEventListener(t, n, {
    passive: l
  }) : e.addEventListener(t, n, !1);
}
function sr(e, t, n, a, l) {
  var i = a;
  if (!(t & 1) && !(t & 2) && a !== null)
    e: for (; ; ) {
      if (a === null) return;
      var o = a.tag;
      if (o === 3 || o === 4) {
        var s = a.stateNode.containerInfo;
        if (s === l) break;
        if (o === 4)
          for (o = a.return; o !== null; ) {
            var c = o.tag;
            if ((c === 3 || c === 4) && o.stateNode.containerInfo === l)
              return;
            o = o.return;
          }
        for (; s !== null; ) {
          if (o = ja(s), o === null) return;
          if (c = o.tag, c === 5 || c === 6 || c === 26 || c === 27) {
            a = i = o;
            continue e;
          }
          s = s.parentNode;
        }
      }
      a = a.return;
    }
  Mm(function() {
    var u = i, m = _c(n), g = [];
    e: {
      var f = qm.get(e);
      if (f !== void 0) {
        var p = ns, C = e;
        switch (e) {
          case "keypress":
            if (Pi(n) === 0) break e;
          case "keydown":
          case "keyup":
            p = M0;
            break;
          case "focusin":
            C = "focus", p = Us;
            break;
          case "focusout":
            C = "blur", p = Us;
            break;
          case "beforeblur":
          case "afterblur":
            p = Us;
            break;
          case "click":
            if (n.button === 2) break e;
          case "auxclick":
          case "dblclick":
          case "mousedown":
          case "mousemove":
          case "mouseup":
          case "mouseout":
          case "mouseover":
          case "contextmenu":
            p = ef;
            break;
          case "drag":
          case "dragend":
          case "dragenter":
          case "dragexit":
          case "dragleave":
          case "dragover":
          case "dragstart":
          case "drop":
            p = v0;
            break;
          case "touchcancel":
          case "touchend":
          case "touchmove":
          case "touchstart":
            p = _0;
            break;
          case Bm:
          case Hm:
          case Gm:
            p = b0;
            break;
          case Ym:
            p = z0;
            break;
          case "scroll":
          case "scrollend":
            p = h0;
            break;
          case "wheel":
            p = k0;
            break;
          case "copy":
          case "cut":
          case "paste":
            p = S0;
            break;
          case "gotpointercapture":
          case "lostpointercapture":
          case "pointercancel":
          case "pointerdown":
          case "pointermove":
          case "pointerout":
          case "pointerover":
          case "pointerup":
            p = nf;
            break;
          case "toggle":
          case "beforetoggle":
            p = V0;
        }
        var x = (t & 4) !== 0, S = !x && (e === "scroll" || e === "scrollend"), h = x ? f !== null ? f + "Capture" : null : f;
        x = [];
        for (var d = u, y; d !== null; ) {
          var b = d;
          if (y = b.stateNode, b = b.tag, b !== 5 && b !== 26 && b !== 27 || y === null || h === null || (b = $l(d, h), b != null && x.push(
            si(d, b, y)
          )), S) break;
          d = d.return;
        }
        0 < x.length && (f = new p(
          f,
          C,
          null,
          n,
          m
        ), g.push({ event: f, listeners: x }));
      }
    }
    if (!(t & 7)) {
      e: {
        if (f = e === "mouseover" || e === "pointerover", p = e === "mouseout" || e === "pointerout", f && n !== Tr && (C = n.relatedTarget || n.fromElement) && (ja(C) || C[sl]))
          break e;
        if ((p || f) && (f = m.window === m ? m : (f = m.ownerDocument) ? f.defaultView || f.parentWindow : window, p ? (C = n.relatedTarget || n.toElement, p = u, C = C ? ja(C) : null, C !== null && (S = di(C), x = C.tag, C !== S || x !== 5 && x !== 27 && x !== 6) && (C = null)) : (p = null, C = u), p !== C)) {
          if (x = ef, b = "onMouseLeave", h = "onMouseEnter", d = "mouse", (e === "pointerout" || e === "pointerover") && (x = nf, b = "onPointerLeave", h = "onPointerEnter", d = "pointer"), S = p == null ? f : Rl(p), y = C == null ? f : Rl(C), f = new x(
            b,
            d + "leave",
            p,
            n,
            m
          ), f.target = S, f.relatedTarget = y, b = null, ja(m) === u && (x = new x(
            h,
            d + "enter",
            C,
            n,
            m
          ), x.target = y, x.relatedTarget = S, b = x), S = b, p && C)
            t: {
              for (x = Ub, h = p, d = C, y = 0, b = h; b; b = x(b))
                y++;
              b = 0;
              for (var N = d; N; N = x(N))
                b++;
              for (; 0 < y - b; )
                h = x(h), y--;
              for (; 0 < b - y; )
                d = x(d), b--;
              for (; y--; ) {
                if (h === d || d !== null && h === d.alternate) {
                  x = h;
                  break t;
                }
                h = x(h), d = x(d);
              }
              x = null;
            }
          else x = null;
          p !== null && Kf(
            g,
            f,
            p,
            x,
            !1
          ), C !== null && S !== null && Kf(
            g,
            S,
            C,
            x,
            !0
          );
        }
      }
      e: {
        if (f = u ? Rl(u) : window, p = f.nodeName && f.nodeName.toLowerCase(), p === "select" || p === "input" && f.type === "file")
          var O = sf;
        else if (of(f))
          if (Rm)
            O = F0;
          else {
            O = Q0;
            var M = X0;
          }
        else
          p = f.nodeName, !p || p.toLowerCase() !== "input" || f.type !== "checkbox" && f.type !== "radio" ? u && Dc(u.elementType) && (O = sf) : O = Z0;
        if (O && (O = O(e, u))) {
          zm(
            g,
            O,
            n,
            m
          );
          break e;
        }
        M && M(e, f, u), e === "focusout" && u && f.type === "number" && u.memoizedProps.value != null && Mr(f, "number", f.value);
      }
      switch (M = u ? Rl(u) : window, e) {
        case "focusin":
          (of(M) || M.contentEditable === "true") && (Da = M, _r = u, Hl = null);
          break;
        case "focusout":
          Hl = _r = Da = null;
          break;
        case "mousedown":
          Or = !0;
          break;
        case "contextmenu":
        case "mouseup":
        case "dragend":
          Or = !1, df(g, n, m);
          break;
        case "selectionchange":
          if (J0) break;
        case "keydown":
        case "keyup":
          df(g, n, m);
      }
      var A;
      if (Rc)
        e: {
          switch (e) {
            case "compositionstart":
              var w = "onCompositionStart";
              break e;
            case "compositionend":
              w = "onCompositionEnd";
              break e;
            case "compositionupdate":
              w = "onCompositionUpdate";
              break e;
          }
          w = void 0;
        }
      else
        Ta ? _m(e, n) && (w = "onCompositionEnd") : e === "keydown" && n.keyCode === 229 && (w = "onCompositionStart");
      w && (Dm && n.locale !== "ko" && (Ta || w !== "onCompositionStart" ? w === "onCompositionEnd" && Ta && (A = Tm()) : (Sn = m, Oc = "value" in Sn ? Sn.value : Sn.textContent, Ta = !0)), M = ko(u, w), 0 < M.length && (w = new tf(
        w,
        e,
        null,
        n,
        m
      ), g.push({ event: w, listeners: M }), A ? w.data = A : (A = Om(n), A !== null && (w.data = A)))), (A = B0 ? H0(e, n) : G0(e, n)) && (w = ko(u, "onBeforeInput"), 0 < w.length && (M = new tf(
        "onBeforeInput",
        "beforeinput",
        null,
        n,
        m
      ), g.push({
        event: M,
        listeners: w
      }), M.data = A)), Ob(
        g,
        e,
        u,
        n,
        m
      );
    }
    Mg(g, t);
  });
}
function si(e, t, n) {
  return {
    instance: e,
    listener: t,
    currentTarget: n
  };
}
function ko(e, t) {
  for (var n = t + "Capture", a = []; e !== null; ) {
    var l = e, i = l.stateNode;
    if (l = l.tag, l !== 5 && l !== 26 && l !== 27 || i === null || (l = $l(e, n), l != null && a.unshift(
      si(e, l, i)
    ), l = $l(e, t), l != null && a.push(
      si(e, l, i)
    )), e.tag === 3) return a;
    e = e.return;
  }
  return [];
}
function Ub(e) {
  if (e === null) return null;
  do
    e = e.return;
  while (e && e.tag !== 5 && e.tag !== 27);
  return e || null;
}
function Kf(e, t, n, a, l) {
  for (var i = t._reactName, o = []; n !== null && n !== a; ) {
    var s = n, c = s.alternate, u = s.stateNode;
    if (s = s.tag, c !== null && c === a) break;
    s !== 5 && s !== 26 && s !== 27 || u === null || (c = u, l ? (u = $l(n, i), u != null && o.unshift(
      si(n, u, c)
    )) : l || (u = $l(n, i), u != null && o.push(
      si(n, u, c)
    ))), n = n.return;
  }
  o.length !== 0 && e.push({ event: t, listeners: o });
}
var Vb = /\r\n?/g, Lb = /\u0000|\uFFFD/g;
function Jf(e) {
  return (typeof e == "string" ? e : "" + e).replace(Vb, `
`).replace(Lb, "");
}
function Dg(e, t) {
  return t = Jf(t), Jf(e) === t;
}
function re(e, t, n, a, l, i) {
  switch (n) {
    case "children":
      typeof a == "string" ? t === "body" || t === "textarea" && a === "" || Ja(e, a) : (typeof a == "number" || typeof a == "bigint") && t !== "body" && Ja(e, "" + a);
      break;
    case "className":
      Ri(e, "class", a);
      break;
    case "tabIndex":
      Ri(e, "tabindex", a);
      break;
    case "dir":
    case "role":
    case "viewBox":
    case "width":
    case "height":
      Ri(e, n, a);
      break;
    case "style":
      jm(e, a, i);
      break;
    case "data":
      if (t !== "object") {
        Ri(e, "data", a);
        break;
      }
    case "src":
    case "href":
      if (a === "" && (t !== "a" || n !== "href")) {
        e.removeAttribute(n);
        break;
      }
      if (a == null || typeof a == "function" || typeof a == "symbol" || typeof a == "boolean") {
        e.removeAttribute(n);
        break;
      }
      a = Wi("" + a), e.setAttribute(n, a);
      break;
    case "action":
    case "formAction":
      if (typeof a == "function") {
        e.setAttribute(
          n,
          "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')"
        );
        break;
      } else
        typeof i == "function" && (n === "formAction" ? (t !== "input" && re(e, t, "name", l.name, l, null), re(
          e,
          t,
          "formEncType",
          l.formEncType,
          l,
          null
        ), re(
          e,
          t,
          "formMethod",
          l.formMethod,
          l,
          null
        ), re(
          e,
          t,
          "formTarget",
          l.formTarget,
          l,
          null
        )) : (re(e, t, "encType", l.encType, l, null), re(e, t, "method", l.method, l, null), re(e, t, "target", l.target, l, null)));
      if (a == null || typeof a == "symbol" || typeof a == "boolean") {
        e.removeAttribute(n);
        break;
      }
      a = Wi("" + a), e.setAttribute(n, a);
      break;
    case "onClick":
      a != null && (e.onclick = Xt);
      break;
    case "onScroll":
      a != null && W("scroll", e);
      break;
    case "onScrollEnd":
      a != null && W("scrollend", e);
      break;
    case "dangerouslySetInnerHTML":
      if (a != null) {
        if (typeof a != "object" || !("__html" in a))
          throw Error(_(61));
        if (n = a.__html, n != null) {
          if (l.children != null) throw Error(_(60));
          e.innerHTML = n;
        }
      }
      break;
    case "multiple":
      e.multiple = a && typeof a != "function" && typeof a != "symbol";
      break;
    case "muted":
      e.muted = a && typeof a != "function" && typeof a != "symbol";
      break;
    case "suppressContentEditableWarning":
    case "suppressHydrationWarning":
    case "defaultValue":
    case "defaultChecked":
    case "innerHTML":
    case "ref":
      break;
    case "autoFocus":
      break;
    case "xlinkHref":
      if (a == null || typeof a == "function" || typeof a == "boolean" || typeof a == "symbol") {
        e.removeAttribute("xlink:href");
        break;
      }
      n = Wi("" + a), e.setAttributeNS(
        "http://www.w3.org/1999/xlink",
        "xlink:href",
        n
      );
      break;
    case "contentEditable":
    case "spellCheck":
    case "draggable":
    case "value":
    case "autoReverse":
    case "externalResourcesRequired":
    case "focusable":
    case "preserveAlpha":
      a != null && typeof a != "function" && typeof a != "symbol" ? e.setAttribute(n, "" + a) : e.removeAttribute(n);
      break;
    case "inert":
    case "allowFullScreen":
    case "async":
    case "autoPlay":
    case "controls":
    case "default":
    case "defer":
    case "disabled":
    case "disablePictureInPicture":
    case "disableRemotePlayback":
    case "formNoValidate":
    case "hidden":
    case "loop":
    case "noModule":
    case "noValidate":
    case "open":
    case "playsInline":
    case "readOnly":
    case "required":
    case "reversed":
    case "scoped":
    case "seamless":
    case "itemScope":
      a && typeof a != "function" && typeof a != "symbol" ? e.setAttribute(n, "") : e.removeAttribute(n);
      break;
    case "capture":
    case "download":
      a === !0 ? e.setAttribute(n, "") : a !== !1 && a != null && typeof a != "function" && typeof a != "symbol" ? e.setAttribute(n, a) : e.removeAttribute(n);
      break;
    case "cols":
    case "rows":
    case "size":
    case "span":
      a != null && typeof a != "function" && typeof a != "symbol" && !isNaN(a) && 1 <= a ? e.setAttribute(n, a) : e.removeAttribute(n);
      break;
    case "rowSpan":
    case "start":
      a == null || typeof a == "function" || typeof a == "symbol" || isNaN(a) ? e.removeAttribute(n) : e.setAttribute(n, a);
      break;
    case "popover":
      W("beforetoggle", e), W("toggle", e), Ii(e, "popover", a);
      break;
    case "xlinkActuate":
      kt(
        e,
        "http://www.w3.org/1999/xlink",
        "xlink:actuate",
        a
      );
      break;
    case "xlinkArcrole":
      kt(
        e,
        "http://www.w3.org/1999/xlink",
        "xlink:arcrole",
        a
      );
      break;
    case "xlinkRole":
      kt(
        e,
        "http://www.w3.org/1999/xlink",
        "xlink:role",
        a
      );
      break;
    case "xlinkShow":
      kt(
        e,
        "http://www.w3.org/1999/xlink",
        "xlink:show",
        a
      );
      break;
    case "xlinkTitle":
      kt(
        e,
        "http://www.w3.org/1999/xlink",
        "xlink:title",
        a
      );
      break;
    case "xlinkType":
      kt(
        e,
        "http://www.w3.org/1999/xlink",
        "xlink:type",
        a
      );
      break;
    case "xmlBase":
      kt(
        e,
        "http://www.w3.org/XML/1998/namespace",
        "xml:base",
        a
      );
      break;
    case "xmlLang":
      kt(
        e,
        "http://www.w3.org/XML/1998/namespace",
        "xml:lang",
        a
      );
      break;
    case "xmlSpace":
      kt(
        e,
        "http://www.w3.org/XML/1998/namespace",
        "xml:space",
        a
      );
      break;
    case "is":
      Ii(e, "is", a);
      break;
    case "innerText":
    case "textContent":
      break;
    default:
      (!(2 < n.length) || n[0] !== "o" && n[0] !== "O" || n[1] !== "n" && n[1] !== "N") && (n = d0.get(n) || n, Ii(e, n, a));
  }
}
function nc(e, t, n, a, l, i) {
  switch (n) {
    case "style":
      jm(e, a, i);
      break;
    case "dangerouslySetInnerHTML":
      if (a != null) {
        if (typeof a != "object" || !("__html" in a))
          throw Error(_(61));
        if (n = a.__html, n != null) {
          if (l.children != null) throw Error(_(60));
          e.innerHTML = n;
        }
      }
      break;
    case "children":
      typeof a == "string" ? Ja(e, a) : (typeof a == "number" || typeof a == "bigint") && Ja(e, "" + a);
      break;
    case "onScroll":
      a != null && W("scroll", e);
      break;
    case "onScrollEnd":
      a != null && W("scrollend", e);
      break;
    case "onClick":
      a != null && (e.onclick = Xt);
      break;
    case "suppressContentEditableWarning":
    case "suppressHydrationWarning":
    case "innerHTML":
    case "ref":
      break;
    case "innerText":
    case "textContent":
      break;
    default:
      if (!Sm.hasOwnProperty(n))
        e: {
          if (n[0] === "o" && n[1] === "n" && (l = n.endsWith("Capture"), t = n.slice(2, l ? n.length - 7 : void 0), i = e[et] || null, i = i != null ? i[n] : null, typeof i == "function" && e.removeEventListener(t, i, l), typeof a == "function")) {
            typeof i != "function" && i !== null && (n in e ? e[n] = null : e.hasAttribute(n) && e.removeAttribute(n)), e.addEventListener(t, a, l);
            break e;
          }
          n in e ? e[n] = a : a === !0 ? e.setAttribute(n, "") : Ii(e, n, a);
        }
  }
}
function Xe(e, t, n) {
  switch (t) {
    case "div":
    case "span":
    case "svg":
    case "path":
    case "a":
    case "g":
    case "p":
    case "li":
      break;
    case "img":
      W("error", e), W("load", e);
      var a = !1, l = !1, i;
      for (i in n)
        if (n.hasOwnProperty(i)) {
          var o = n[i];
          if (o != null)
            switch (i) {
              case "src":
                a = !0;
                break;
              case "srcSet":
                l = !0;
                break;
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(_(137, t));
              default:
                re(e, t, i, o, n, null);
            }
        }
      l && re(e, t, "srcSet", n.srcSet, n, null), a && re(e, t, "src", n.src, n, null);
      return;
    case "input":
      W("invalid", e);
      var s = i = o = l = null, c = null, u = null;
      for (a in n)
        if (n.hasOwnProperty(a)) {
          var m = n[a];
          if (m != null)
            switch (a) {
              case "name":
                l = m;
                break;
              case "type":
                o = m;
                break;
              case "checked":
                c = m;
                break;
              case "defaultChecked":
                u = m;
                break;
              case "value":
                i = m;
                break;
              case "defaultValue":
                s = m;
                break;
              case "children":
              case "dangerouslySetInnerHTML":
                if (m != null)
                  throw Error(_(137, t));
                break;
              default:
                re(e, t, a, m, n, null);
            }
        }
      Am(
        e,
        i,
        s,
        c,
        u,
        o,
        l,
        !1
      );
      return;
    case "select":
      W("invalid", e), a = o = i = null;
      for (l in n)
        if (n.hasOwnProperty(l) && (s = n[l], s != null))
          switch (l) {
            case "value":
              i = s;
              break;
            case "defaultValue":
              o = s;
              break;
            case "multiple":
              a = s;
            default:
              re(e, t, l, s, n, null);
          }
      t = i, n = o, e.multiple = !!a, t != null ? Ha(e, !!a, t, !1) : n != null && Ha(e, !!a, n, !0);
      return;
    case "textarea":
      W("invalid", e), i = l = a = null;
      for (o in n)
        if (n.hasOwnProperty(o) && (s = n[o], s != null))
          switch (o) {
            case "value":
              a = s;
              break;
            case "defaultValue":
              l = s;
              break;
            case "children":
              i = s;
              break;
            case "dangerouslySetInnerHTML":
              if (s != null) throw Error(_(91));
              break;
            default:
              re(e, t, o, s, n, null);
          }
      Em(e, a, l, i);
      return;
    case "option":
      for (c in n)
        if (n.hasOwnProperty(c) && (a = n[c], a != null))
          switch (c) {
            case "selected":
              e.selected = a && typeof a != "function" && typeof a != "symbol";
              break;
            default:
              re(e, t, c, a, n, null);
          }
      return;
    case "dialog":
      W("beforetoggle", e), W("toggle", e), W("cancel", e), W("close", e);
      break;
    case "iframe":
    case "object":
      W("load", e);
      break;
    case "video":
    case "audio":
      for (a = 0; a < oi.length; a++)
        W(oi[a], e);
      break;
    case "image":
      W("error", e), W("load", e);
      break;
    case "details":
      W("toggle", e);
      break;
    case "embed":
    case "source":
    case "link":
      W("error", e), W("load", e);
    case "area":
    case "base":
    case "br":
    case "col":
    case "hr":
    case "keygen":
    case "meta":
    case "param":
    case "track":
    case "wbr":
    case "menuitem":
      for (u in n)
        if (n.hasOwnProperty(u) && (a = n[u], a != null))
          switch (u) {
            case "children":
            case "dangerouslySetInnerHTML":
              throw Error(_(137, t));
            default:
              re(e, t, u, a, n, null);
          }
      return;
    default:
      if (Dc(t)) {
        for (m in n)
          n.hasOwnProperty(m) && (a = n[m], a !== void 0 && nc(
            e,
            t,
            m,
            a,
            n,
            void 0
          ));
        return;
      }
  }
  for (s in n)
    n.hasOwnProperty(s) && (a = n[s], a != null && re(e, t, s, a, n, null));
}
function Bb(e, t, n, a) {
  switch (t) {
    case "div":
    case "span":
    case "svg":
    case "path":
    case "a":
    case "g":
    case "p":
    case "li":
      break;
    case "input":
      var l = null, i = null, o = null, s = null, c = null, u = null, m = null;
      for (p in n) {
        var g = n[p];
        if (n.hasOwnProperty(p) && g != null)
          switch (p) {
            case "checked":
              break;
            case "value":
              break;
            case "defaultValue":
              c = g;
            default:
              a.hasOwnProperty(p) || re(e, t, p, null, a, g);
          }
      }
      for (var f in a) {
        var p = a[f];
        if (g = n[f], a.hasOwnProperty(f) && (p != null || g != null))
          switch (f) {
            case "type":
              i = p;
              break;
            case "name":
              l = p;
              break;
            case "checked":
              u = p;
              break;
            case "defaultChecked":
              m = p;
              break;
            case "value":
              o = p;
              break;
            case "defaultValue":
              s = p;
              break;
            case "children":
            case "dangerouslySetInnerHTML":
              if (p != null)
                throw Error(_(137, t));
              break;
            default:
              p !== g && re(
                e,
                t,
                f,
                p,
                a,
                g
              );
          }
      }
      jr(
        e,
        o,
        s,
        c,
        u,
        m,
        i,
        l
      );
      return;
    case "select":
      p = o = s = f = null;
      for (i in n)
        if (c = n[i], n.hasOwnProperty(i) && c != null)
          switch (i) {
            case "value":
              break;
            case "multiple":
              p = c;
            default:
              a.hasOwnProperty(i) || re(
                e,
                t,
                i,
                null,
                a,
                c
              );
          }
      for (l in a)
        if (i = a[l], c = n[l], a.hasOwnProperty(l) && (i != null || c != null))
          switch (l) {
            case "value":
              f = i;
              break;
            case "defaultValue":
              s = i;
              break;
            case "multiple":
              o = i;
            default:
              i !== c && re(
                e,
                t,
                l,
                i,
                a,
                c
              );
          }
      t = s, n = o, a = p, f != null ? Ha(e, !!n, f, !1) : !!a != !!n && (t != null ? Ha(e, !!n, t, !0) : Ha(e, !!n, n ? [] : "", !1));
      return;
    case "textarea":
      p = f = null;
      for (s in n)
        if (l = n[s], n.hasOwnProperty(s) && l != null && !a.hasOwnProperty(s))
          switch (s) {
            case "value":
              break;
            case "children":
              break;
            default:
              re(e, t, s, null, a, l);
          }
      for (o in a)
        if (l = a[o], i = n[o], a.hasOwnProperty(o) && (l != null || i != null))
          switch (o) {
            case "value":
              f = l;
              break;
            case "defaultValue":
              p = l;
              break;
            case "children":
              break;
            case "dangerouslySetInnerHTML":
              if (l != null) throw Error(_(91));
              break;
            default:
              l !== i && re(e, t, o, l, a, i);
          }
      Nm(e, f, p);
      return;
    case "option":
      for (var C in n)
        if (f = n[C], n.hasOwnProperty(C) && f != null && !a.hasOwnProperty(C))
          switch (C) {
            case "selected":
              e.selected = !1;
              break;
            default:
              re(
                e,
                t,
                C,
                null,
                a,
                f
              );
          }
      for (c in a)
        if (f = a[c], p = n[c], a.hasOwnProperty(c) && f !== p && (f != null || p != null))
          switch (c) {
            case "selected":
              e.selected = f && typeof f != "function" && typeof f != "symbol";
              break;
            default:
              re(
                e,
                t,
                c,
                f,
                a,
                p
              );
          }
      return;
    case "img":
    case "link":
    case "area":
    case "base":
    case "br":
    case "col":
    case "embed":
    case "hr":
    case "keygen":
    case "meta":
    case "param":
    case "source":
    case "track":
    case "wbr":
    case "menuitem":
      for (var x in n)
        f = n[x], n.hasOwnProperty(x) && f != null && !a.hasOwnProperty(x) && re(e, t, x, null, a, f);
      for (u in a)
        if (f = a[u], p = n[u], a.hasOwnProperty(u) && f !== p && (f != null || p != null))
          switch (u) {
            case "children":
            case "dangerouslySetInnerHTML":
              if (f != null)
                throw Error(_(137, t));
              break;
            default:
              re(
                e,
                t,
                u,
                f,
                a,
                p
              );
          }
      return;
    default:
      if (Dc(t)) {
        for (var S in n)
          f = n[S], n.hasOwnProperty(S) && f !== void 0 && !a.hasOwnProperty(S) && nc(
            e,
            t,
            S,
            void 0,
            a,
            f
          );
        for (m in a)
          f = a[m], p = n[m], !a.hasOwnProperty(m) || f === p || f === void 0 && p === void 0 || nc(
            e,
            t,
            m,
            f,
            a,
            p
          );
        return;
      }
  }
  for (var h in n)
    f = n[h], n.hasOwnProperty(h) && f != null && !a.hasOwnProperty(h) && re(e, t, h, null, a, f);
  for (g in a)
    f = a[g], p = n[g], !a.hasOwnProperty(g) || f === p || f == null && p == null || re(e, t, g, f, a, p);
}
function If(e) {
  switch (e) {
    case "css":
    case "script":
    case "font":
    case "img":
    case "image":
    case "input":
    case "link":
      return !0;
    default:
      return !1;
  }
}
function Hb() {
  if (typeof performance.getEntriesByType == "function") {
    for (var e = 0, t = 0, n = performance.getEntriesByType("resource"), a = 0; a < n.length; a++) {
      var l = n[a], i = l.transferSize, o = l.initiatorType, s = l.duration;
      if (i && s && If(o)) {
        for (o = 0, s = l.responseEnd, a += 1; a < n.length; a++) {
          var c = n[a], u = c.startTime;
          if (u > s) break;
          var m = c.transferSize, g = c.initiatorType;
          m && If(g) && (c = c.responseEnd, o += m * (c < s ? 1 : (s - u) / (c - u)));
        }
        if (--a, t += 8 * (i + o) / (l.duration / 1e3), e++, 10 < e) break;
      }
    }
    if (0 < e) return t / e / 1e6;
  }
  return navigator.connection && (e = navigator.connection.downlink, typeof e == "number") ? e : 5;
}
var ac = null, lc = null;
function Uo(e) {
  return e.nodeType === 9 ? e : e.ownerDocument;
}
function Wf(e) {
  switch (e) {
    case "http://www.w3.org/2000/svg":
      return 1;
    case "http://www.w3.org/1998/Math/MathML":
      return 2;
    default:
      return 0;
  }
}
function _g(e, t) {
  if (e === 0)
    switch (t) {
      case "svg":
        return 1;
      case "math":
        return 2;
      default:
        return 0;
    }
  return e === 1 && t === "foreignObject" ? 0 : e;
}
function ic(e, t) {
  return e === "textarea" || e === "noscript" || typeof t.children == "string" || typeof t.children == "number" || typeof t.children == "bigint" || typeof t.dangerouslySetInnerHTML == "object" && t.dangerouslySetInnerHTML !== null && t.dangerouslySetInnerHTML.__html != null;
}
var rr = null;
function Gb() {
  var e = window.event;
  return e && e.type === "popstate" ? e === rr ? !1 : (rr = e, !0) : (rr = null, !1);
}
var Og = typeof setTimeout == "function" ? setTimeout : void 0, Yb = typeof clearTimeout == "function" ? clearTimeout : void 0, $f = typeof Promise == "function" ? Promise : void 0, qb = typeof queueMicrotask == "function" ? queueMicrotask : typeof $f < "u" ? function(e) {
  return $f.resolve(null).then(e).catch(Xb);
} : Og;
function Xb(e) {
  setTimeout(function() {
    throw e;
  });
}
function Yn(e) {
  return e === "head";
}
function Pf(e, t) {
  var n = t, a = 0;
  do {
    var l = n.nextSibling;
    if (e.removeChild(n), l && l.nodeType === 8)
      if (n = l.data, n === "/$" || n === "/&") {
        if (a === 0) {
          e.removeChild(l), al(t);
          return;
        }
        a--;
      } else if (n === "$" || n === "$?" || n === "$~" || n === "$!" || n === "&")
        a++;
      else if (n === "html")
        Il(e.ownerDocument.documentElement);
      else if (n === "head") {
        n = e.ownerDocument.head, Il(n);
        for (var i = n.firstChild; i; ) {
          var o = i.nextSibling, s = i.nodeName;
          i[vi] || s === "SCRIPT" || s === "STYLE" || s === "LINK" && i.rel.toLowerCase() === "stylesheet" || n.removeChild(i), i = o;
        }
      } else
        n === "body" && Il(e.ownerDocument.body);
    n = l;
  } while (n);
  al(t);
}
function ed(e, t) {
  var n = e;
  e = 0;
  do {
    var a = n.nextSibling;
    if (n.nodeType === 1 ? t ? (n._stashedDisplay = n.style.display, n.style.display = "none") : (n.style.display = n._stashedDisplay || "", n.getAttribute("style") === "" && n.removeAttribute("style")) : n.nodeType === 3 && (t ? (n._stashedText = n.nodeValue, n.nodeValue = "") : n.nodeValue = n._stashedText || ""), a && a.nodeType === 8)
      if (n = a.data, n === "/$") {
        if (e === 0) break;
        e--;
      } else
        n !== "$" && n !== "$?" && n !== "$~" && n !== "$!" || e++;
    n = a;
  } while (n);
}
function oc(e) {
  var t = e.firstChild;
  for (t && t.nodeType === 10 && (t = t.nextSibling); t; ) {
    var n = t;
    switch (t = t.nextSibling, n.nodeName) {
      case "HTML":
      case "HEAD":
      case "BODY":
        oc(n), Tc(n);
        continue;
      case "SCRIPT":
      case "STYLE":
        continue;
      case "LINK":
        if (n.rel.toLowerCase() === "stylesheet") continue;
    }
    e.removeChild(n);
  }
}
function Qb(e, t, n, a) {
  for (; e.nodeType === 1; ) {
    var l = n;
    if (e.nodeName.toLowerCase() !== t.toLowerCase()) {
      if (!a && (e.nodeName !== "INPUT" || e.type !== "hidden"))
        break;
    } else if (a) {
      if (!e[vi])
        switch (t) {
          case "meta":
            if (!e.hasAttribute("itemprop")) break;
            return e;
          case "link":
            if (i = e.getAttribute("rel"), i === "stylesheet" && e.hasAttribute("data-precedence"))
              break;
            if (i !== l.rel || e.getAttribute("href") !== (l.href == null || l.href === "" ? null : l.href) || e.getAttribute("crossorigin") !== (l.crossOrigin == null ? null : l.crossOrigin) || e.getAttribute("title") !== (l.title == null ? null : l.title))
              break;
            return e;
          case "style":
            if (e.hasAttribute("data-precedence")) break;
            return e;
          case "script":
            if (i = e.getAttribute("src"), (i !== (l.src == null ? null : l.src) || e.getAttribute("type") !== (l.type == null ? null : l.type) || e.getAttribute("crossorigin") !== (l.crossOrigin == null ? null : l.crossOrigin)) && i && e.hasAttribute("async") && !e.hasAttribute("itemprop"))
              break;
            return e;
          default:
            return e;
        }
    } else if (t === "input" && e.type === "hidden") {
      var i = l.name == null ? null : "" + l.name;
      if (l.type === "hidden" && e.getAttribute("name") === i)
        return e;
    } else return e;
    if (e = xt(e.nextSibling), e === null) break;
  }
  return null;
}
function Zb(e, t, n) {
  if (t === "") return null;
  for (; e.nodeType !== 3; )
    if ((e.nodeType !== 1 || e.nodeName !== "INPUT" || e.type !== "hidden") && !n || (e = xt(e.nextSibling), e === null)) return null;
  return e;
}
function zg(e, t) {
  for (; e.nodeType !== 8; )
    if ((e.nodeType !== 1 || e.nodeName !== "INPUT" || e.type !== "hidden") && !t || (e = xt(e.nextSibling), e === null)) return null;
  return e;
}
function sc(e) {
  return e.data === "$?" || e.data === "$~";
}
function rc(e) {
  return e.data === "$!" || e.data === "$?" && e.ownerDocument.readyState !== "loading";
}
function Fb(e, t) {
  var n = e.ownerDocument;
  if (e.data === "$~") e._reactRetry = t;
  else if (e.data !== "$?" || n.readyState !== "loading")
    t();
  else {
    var a = function() {
      t(), n.removeEventListener("DOMContentLoaded", a);
    };
    n.addEventListener("DOMContentLoaded", a), e._reactRetry = a;
  }
}
function xt(e) {
  for (; e != null; e = e.nextSibling) {
    var t = e.nodeType;
    if (t === 1 || t === 3) break;
    if (t === 8) {
      if (t = e.data, t === "$" || t === "$!" || t === "$?" || t === "$~" || t === "&" || t === "F!" || t === "F")
        break;
      if (t === "/$" || t === "/&") return null;
    }
  }
  return e;
}
var cc = null;
function td(e) {
  e = e.nextSibling;
  for (var t = 0; e; ) {
    if (e.nodeType === 8) {
      var n = e.data;
      if (n === "/$" || n === "/&") {
        if (t === 0)
          return xt(e.nextSibling);
        t--;
      } else
        n !== "$" && n !== "$!" && n !== "$?" && n !== "$~" && n !== "&" || t++;
    }
    e = e.nextSibling;
  }
  return null;
}
function nd(e) {
  e = e.previousSibling;
  for (var t = 0; e; ) {
    if (e.nodeType === 8) {
      var n = e.data;
      if (n === "$" || n === "$!" || n === "$?" || n === "$~" || n === "&") {
        if (t === 0) return e;
        t--;
      } else n !== "/$" && n !== "/&" || t++;
    }
    e = e.previousSibling;
  }
  return null;
}
function Rg(e, t, n) {
  switch (t = Uo(n), e) {
    case "html":
      if (e = t.documentElement, !e) throw Error(_(452));
      return e;
    case "head":
      if (e = t.head, !e) throw Error(_(453));
      return e;
    case "body":
      if (e = t.body, !e) throw Error(_(454));
      return e;
    default:
      throw Error(_(451));
  }
}
function Il(e) {
  for (var t = e.attributes; t.length; )
    e.removeAttributeNode(t[0]);
  Tc(e);
}
var St = /* @__PURE__ */ new Map(), ad = /* @__PURE__ */ new Set();
function Vo(e) {
  return typeof e.getRootNode == "function" ? e.getRootNode() : e.nodeType === 9 ? e : e.ownerDocument;
}
var nn = le.d;
le.d = {
  f: Kb,
  r: Jb,
  D: Ib,
  C: Wb,
  L: $b,
  m: Pb,
  X: t1,
  S: e1,
  M: n1
};
function Kb() {
  var e = nn.f(), t = ms();
  return e || t;
}
function Jb(e) {
  var t = rl(e);
  t !== null && t.tag === 5 && t.type === "form" ? jh(t) : nn.r(e);
}
var dl = typeof document > "u" ? null : document;
function kg(e, t, n) {
  var a = dl;
  if (a && typeof t == "string" && t) {
    var l = vt(t);
    l = 'link[rel="' + e + '"][href="' + l + '"]', typeof n == "string" && (l += '[crossorigin="' + n + '"]'), ad.has(l) || (ad.add(l), e = { rel: e, crossOrigin: n, href: t }, a.querySelector(l) === null && (t = a.createElement("link"), Xe(t, "link", e), Ue(t), a.head.appendChild(t)));
  }
}
function Ib(e) {
  nn.D(e), kg("dns-prefetch", e, null);
}
function Wb(e, t) {
  nn.C(e, t), kg("preconnect", e, t);
}
function $b(e, t, n) {
  nn.L(e, t, n);
  var a = dl;
  if (a && e && t) {
    var l = 'link[rel="preload"][as="' + vt(t) + '"]';
    t === "image" && n && n.imageSrcSet ? (l += '[imagesrcset="' + vt(
      n.imageSrcSet
    ) + '"]', typeof n.imageSizes == "string" && (l += '[imagesizes="' + vt(
      n.imageSizes
    ) + '"]')) : l += '[href="' + vt(e) + '"]';
    var i = l;
    switch (t) {
      case "style":
        i = nl(e);
        break;
      case "script":
        i = ml(e);
    }
    St.has(i) || (e = pe(
      {
        rel: "preload",
        href: t === "image" && n && n.imageSrcSet ? void 0 : e,
        as: t
      },
      n
    ), St.set(i, e), a.querySelector(l) !== null || t === "style" && a.querySelector(Ci(i)) || t === "script" && a.querySelector(wi(i)) || (t = a.createElement("link"), Xe(t, "link", e), Ue(t), a.head.appendChild(t)));
  }
}
function Pb(e, t) {
  nn.m(e, t);
  var n = dl;
  if (n && e) {
    var a = t && typeof t.as == "string" ? t.as : "script", l = 'link[rel="modulepreload"][as="' + vt(a) + '"][href="' + vt(e) + '"]', i = l;
    switch (a) {
      case "audioworklet":
      case "paintworklet":
      case "serviceworker":
      case "sharedworker":
      case "worker":
      case "script":
        i = ml(e);
    }
    if (!St.has(i) && (e = pe({ rel: "modulepreload", href: e }, t), St.set(i, e), n.querySelector(l) === null)) {
      switch (a) {
        case "audioworklet":
        case "paintworklet":
        case "serviceworker":
        case "sharedworker":
        case "worker":
        case "script":
          if (n.querySelector(wi(i)))
            return;
      }
      a = n.createElement("link"), Xe(a, "link", e), Ue(a), n.head.appendChild(a);
    }
  }
}
function e1(e, t, n) {
  nn.S(e, t, n);
  var a = dl;
  if (a && e) {
    var l = Ba(a).hoistableStyles, i = nl(e);
    t = t || "default";
    var o = l.get(i);
    if (!o) {
      var s = { loading: 0, preload: null };
      if (o = a.querySelector(
        Ci(i)
      ))
        s.loading = 5;
      else {
        e = pe(
          { rel: "stylesheet", href: e, "data-precedence": t },
          n
        ), (n = St.get(i)) && hu(e, n);
        var c = o = a.createElement("link");
        Ue(c), Xe(c, "link", e), c._p = new Promise(function(u, m) {
          c.onload = u, c.onerror = m;
        }), c.addEventListener("load", function() {
          s.loading |= 1;
        }), c.addEventListener("error", function() {
          s.loading |= 2;
        }), s.loading |= 4, so(o, t, a);
      }
      o = {
        type: "stylesheet",
        instance: o,
        count: 1,
        state: s
      }, l.set(i, o);
    }
  }
}
function t1(e, t) {
  nn.X(e, t);
  var n = dl;
  if (n && e) {
    var a = Ba(n).hoistableScripts, l = ml(e), i = a.get(l);
    i || (i = n.querySelector(wi(l)), i || (e = pe({ src: e, async: !0 }, t), (t = St.get(l)) && gu(e, t), i = n.createElement("script"), Ue(i), Xe(i, "link", e), n.head.appendChild(i)), i = {
      type: "script",
      instance: i,
      count: 1,
      state: null
    }, a.set(l, i));
  }
}
function n1(e, t) {
  nn.M(e, t);
  var n = dl;
  if (n && e) {
    var a = Ba(n).hoistableScripts, l = ml(e), i = a.get(l);
    i || (i = n.querySelector(wi(l)), i || (e = pe({ src: e, async: !0, type: "module" }, t), (t = St.get(l)) && gu(e, t), i = n.createElement("script"), Ue(i), Xe(i, "link", e), n.head.appendChild(i)), i = {
      type: "script",
      instance: i,
      count: 1,
      state: null
    }, a.set(l, i));
  }
}
function ld(e, t, n, a) {
  var l = (l = En.current) ? Vo(l) : null;
  if (!l) throw Error(_(446));
  switch (e) {
    case "meta":
    case "title":
      return null;
    case "style":
      return typeof n.precedence == "string" && typeof n.href == "string" ? (t = nl(n.href), n = Ba(
        l
      ).hoistableStyles, a = n.get(t), a || (a = {
        type: "style",
        instance: null,
        count: 0,
        state: null
      }, n.set(t, a)), a) : { type: "void", instance: null, count: 0, state: null };
    case "link":
      if (n.rel === "stylesheet" && typeof n.href == "string" && typeof n.precedence == "string") {
        e = nl(n.href);
        var i = Ba(
          l
        ).hoistableStyles, o = i.get(e);
        if (o || (l = l.ownerDocument || l, o = {
          type: "stylesheet",
          instance: null,
          count: 0,
          state: { loading: 0, preload: null }
        }, i.set(e, o), (i = l.querySelector(
          Ci(e)
        )) && !i._p && (o.instance = i, o.state.loading = 5), St.has(e) || (n = {
          rel: "preload",
          as: "style",
          href: n.href,
          crossOrigin: n.crossOrigin,
          integrity: n.integrity,
          media: n.media,
          hrefLang: n.hrefLang,
          referrerPolicy: n.referrerPolicy
        }, St.set(e, n), i || a1(
          l,
          e,
          n,
          o.state
        ))), t && a === null)
          throw Error(_(528, ""));
        return o;
      }
      if (t && a !== null)
        throw Error(_(529, ""));
      return null;
    case "script":
      return t = n.async, n = n.src, typeof n == "string" && t && typeof t != "function" && typeof t != "symbol" ? (t = ml(n), n = Ba(
        l
      ).hoistableScripts, a = n.get(t), a || (a = {
        type: "script",
        instance: null,
        count: 0,
        state: null
      }, n.set(t, a)), a) : { type: "void", instance: null, count: 0, state: null };
    default:
      throw Error(_(444, e));
  }
}
function nl(e) {
  return 'href="' + vt(e) + '"';
}
function Ci(e) {
  return 'link[rel="stylesheet"][' + e + "]";
}
function Ug(e) {
  return pe({}, e, {
    "data-precedence": e.precedence,
    precedence: null
  });
}
function a1(e, t, n, a) {
  e.querySelector('link[rel="preload"][as="style"][' + t + "]") ? a.loading = 1 : (t = e.createElement("link"), a.preload = t, t.addEventListener("load", function() {
    return a.loading |= 1;
  }), t.addEventListener("error", function() {
    return a.loading |= 2;
  }), Xe(t, "link", n), Ue(t), e.head.appendChild(t));
}
function ml(e) {
  return '[src="' + vt(e) + '"]';
}
function wi(e) {
  return "script[async]" + e;
}
function id(e, t, n) {
  if (t.count++, t.instance === null)
    switch (t.type) {
      case "style":
        var a = e.querySelector(
          'style[data-href~="' + vt(n.href) + '"]'
        );
        if (a)
          return t.instance = a, Ue(a), a;
        var l = pe({}, n, {
          "data-href": n.href,
          "data-precedence": n.precedence,
          href: null,
          precedence: null
        });
        return a = (e.ownerDocument || e).createElement(
          "style"
        ), Ue(a), Xe(a, "style", l), so(a, n.precedence, e), t.instance = a;
      case "stylesheet":
        l = nl(n.href);
        var i = e.querySelector(
          Ci(l)
        );
        if (i)
          return t.state.loading |= 4, t.instance = i, Ue(i), i;
        a = Ug(n), (l = St.get(l)) && hu(a, l), i = (e.ownerDocument || e).createElement("link"), Ue(i);
        var o = i;
        return o._p = new Promise(function(s, c) {
          o.onload = s, o.onerror = c;
        }), Xe(i, "link", a), t.state.loading |= 4, so(i, n.precedence, e), t.instance = i;
      case "script":
        return i = ml(n.src), (l = e.querySelector(
          wi(i)
        )) ? (t.instance = l, Ue(l), l) : (a = n, (l = St.get(i)) && (a = pe({}, n), gu(a, l)), e = e.ownerDocument || e, l = e.createElement("script"), Ue(l), Xe(l, "link", a), e.head.appendChild(l), t.instance = l);
      case "void":
        return null;
      default:
        throw Error(_(443, t.type));
    }
  else
    t.type === "stylesheet" && !(t.state.loading & 4) && (a = t.instance, t.state.loading |= 4, so(a, n.precedence, e));
  return t.instance;
}
function so(e, t, n) {
  for (var a = n.querySelectorAll(
    'link[rel="stylesheet"][data-precedence],style[data-precedence]'
  ), l = a.length ? a[a.length - 1] : null, i = l, o = 0; o < a.length; o++) {
    var s = a[o];
    if (s.dataset.precedence === t) i = s;
    else if (i !== l) break;
  }
  i ? i.parentNode.insertBefore(e, i.nextSibling) : (t = n.nodeType === 9 ? n.head : n, t.insertBefore(e, t.firstChild));
}
function hu(e, t) {
  e.crossOrigin == null && (e.crossOrigin = t.crossOrigin), e.referrerPolicy == null && (e.referrerPolicy = t.referrerPolicy), e.title == null && (e.title = t.title);
}
function gu(e, t) {
  e.crossOrigin == null && (e.crossOrigin = t.crossOrigin), e.referrerPolicy == null && (e.referrerPolicy = t.referrerPolicy), e.integrity == null && (e.integrity = t.integrity);
}
var ro = null;
function od(e, t, n) {
  if (ro === null) {
    var a = /* @__PURE__ */ new Map(), l = ro = /* @__PURE__ */ new Map();
    l.set(n, a);
  } else
    l = ro, a = l.get(n), a || (a = /* @__PURE__ */ new Map(), l.set(n, a));
  if (a.has(e)) return a;
  for (a.set(e, null), n = n.getElementsByTagName(e), l = 0; l < n.length; l++) {
    var i = n[l];
    if (!(i[vi] || i[Ge] || e === "link" && i.getAttribute("rel") === "stylesheet") && i.namespaceURI !== "http://www.w3.org/2000/svg") {
      var o = i.getAttribute(t) || "";
      o = e + o;
      var s = a.get(o);
      s ? s.push(i) : a.set(o, [i]);
    }
  }
  return a;
}
function sd(e, t, n) {
  e = e.ownerDocument || e, e.head.insertBefore(
    n,
    t === "title" ? e.querySelector("head > title") : null
  );
}
function l1(e, t, n) {
  if (n === 1 || t.itemProp != null) return !1;
  switch (e) {
    case "meta":
    case "title":
      return !0;
    case "style":
      if (typeof t.precedence != "string" || typeof t.href != "string" || t.href === "")
        break;
      return !0;
    case "link":
      if (typeof t.rel != "string" || typeof t.href != "string" || t.href === "" || t.onLoad || t.onError)
        break;
      switch (t.rel) {
        case "stylesheet":
          return e = t.disabled, typeof t.precedence == "string" && e == null;
        default:
          return !0;
      }
    case "script":
      if (t.async && typeof t.async != "function" && typeof t.async != "symbol" && !t.onLoad && !t.onError && t.src && typeof t.src == "string")
        return !0;
  }
  return !1;
}
function Vg(e) {
  return !(e.type === "stylesheet" && !(e.state.loading & 3));
}
function i1(e, t, n, a) {
  if (n.type === "stylesheet" && (typeof a.media != "string" || matchMedia(a.media).matches !== !1) && !(n.state.loading & 4)) {
    if (n.instance === null) {
      var l = nl(a.href), i = t.querySelector(
        Ci(l)
      );
      if (i) {
        t = i._p, t !== null && typeof t == "object" && typeof t.then == "function" && (e.count++, e = Lo.bind(e), t.then(e, e)), n.state.loading |= 4, n.instance = i, Ue(i);
        return;
      }
      i = t.ownerDocument || t, a = Ug(a), (l = St.get(l)) && hu(a, l), i = i.createElement("link"), Ue(i);
      var o = i;
      o._p = new Promise(function(s, c) {
        o.onload = s, o.onerror = c;
      }), Xe(i, "link", a), n.instance = i;
    }
    e.stylesheets === null && (e.stylesheets = /* @__PURE__ */ new Map()), e.stylesheets.set(n, t), (t = n.state.preload) && !(n.state.loading & 3) && (e.count++, n = Lo.bind(e), t.addEventListener("load", n), t.addEventListener("error", n));
  }
}
var cr = 0;
function o1(e, t) {
  return e.stylesheets && e.count === 0 && co(e, e.stylesheets), 0 < e.count || 0 < e.imgCount ? function(n) {
    var a = setTimeout(function() {
      if (e.stylesheets && co(e, e.stylesheets), e.unsuspend) {
        var i = e.unsuspend;
        e.unsuspend = null, i();
      }
    }, 6e4 + t);
    0 < e.imgBytes && cr === 0 && (cr = 62500 * Hb());
    var l = setTimeout(
      function() {
        if (e.waitingForImages = !1, e.count === 0 && (e.stylesheets && co(e, e.stylesheets), e.unsuspend)) {
          var i = e.unsuspend;
          e.unsuspend = null, i();
        }
      },
      (e.imgBytes > cr ? 50 : 800) + t
    );
    return e.unsuspend = n, function() {
      e.unsuspend = null, clearTimeout(a), clearTimeout(l);
    };
  } : null;
}
function Lo() {
  if (this.count--, this.count === 0 && (this.imgCount === 0 || !this.waitingForImages)) {
    if (this.stylesheets) co(this, this.stylesheets);
    else if (this.unsuspend) {
      var e = this.unsuspend;
      this.unsuspend = null, e();
    }
  }
}
var Bo = null;
function co(e, t) {
  e.stylesheets = null, e.unsuspend !== null && (e.count++, Bo = /* @__PURE__ */ new Map(), t.forEach(s1, e), Bo = null, Lo.call(e));
}
function s1(e, t) {
  if (!(t.state.loading & 4)) {
    var n = Bo.get(e);
    if (n) var a = n.get(null);
    else {
      n = /* @__PURE__ */ new Map(), Bo.set(e, n);
      for (var l = e.querySelectorAll(
        "link[data-precedence],style[data-precedence]"
      ), i = 0; i < l.length; i++) {
        var o = l[i];
        (o.nodeName === "LINK" || o.getAttribute("media") !== "not all") && (n.set(o.dataset.precedence, o), a = o);
      }
      a && n.set(null, a);
    }
    l = t.instance, o = l.getAttribute("data-precedence"), i = n.get(o) || a, i === a && n.set(null, l), n.set(o, l), this.count++, a = Lo.bind(this), l.addEventListener("load", a), l.addEventListener("error", a), i ? i.parentNode.insertBefore(l, i.nextSibling) : (e = e.nodeType === 9 ? e.head : e, e.insertBefore(l, e.firstChild)), t.state.loading |= 4;
  }
}
var ri = {
  $$typeof: qt,
  Provider: null,
  Consumer: null,
  _currentValue: Pn,
  _currentValue2: Pn,
  _threadCount: 0
};
function r1(e, t, n, a, l, i, o, s, c) {
  this.tag = 1, this.containerInfo = e, this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null, this.callbackPriority = 0, this.expirationTimes = Os(-1), this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = Os(0), this.hiddenUpdates = Os(null), this.identifierPrefix = a, this.onUncaughtError = l, this.onCaughtError = i, this.onRecoverableError = o, this.pooledCache = null, this.pooledCacheLanes = 0, this.formState = c, this.incompleteTransitions = /* @__PURE__ */ new Map();
}
function Lg(e, t, n, a, l, i, o, s, c, u, m, g) {
  return e = new r1(
    e,
    t,
    n,
    o,
    c,
    u,
    m,
    g,
    s
  ), t = 1, i === !0 && (t |= 24), i = lt(3, null, null, t), e.current = i, i.stateNode = e, t = Gc(), t.refCount++, e.pooledCache = t, t.refCount++, i.memoizedState = {
    element: a,
    isDehydrated: n,
    cache: t
  }, Xc(i), e;
}
function Bg(e) {
  return e ? (e = za, e) : za;
}
function Hg(e, t, n, a, l, i) {
  l = Bg(l), a.context === null ? a.context = l : a.pendingContext = l, a = Mn(t), a.payload = { element: n }, i = i === void 0 ? null : i, i !== null && (a.callback = i), n = Tn(e, a, t), n !== null && (Pe(n, e, t), Yl(n, e, t));
}
function rd(e, t) {
  if (e = e.memoizedState, e !== null && e.dehydrated !== null) {
    var n = e.retryLane;
    e.retryLane = n !== 0 && n < t ? n : t;
  }
}
function vu(e, t) {
  rd(e, t), (e = e.alternate) && rd(e, t);
}
function Gg(e) {
  if (e.tag === 13 || e.tag === 31) {
    var t = ma(e, 67108864);
    t !== null && Pe(t, e, 67108864), vu(e, 67108864);
  }
}
function cd(e) {
  if (e.tag === 13 || e.tag === 31) {
    var t = ct();
    t = jc(t);
    var n = ma(e, t);
    n !== null && Pe(n, e, t), vu(e, t);
  }
}
var Ho = !0;
function c1(e, t, n, a) {
  var l = G.T;
  G.T = null;
  var i = le.p;
  try {
    le.p = 2, pu(e, t, n, a);
  } finally {
    le.p = i, G.T = l;
  }
}
function u1(e, t, n, a) {
  var l = G.T;
  G.T = null;
  var i = le.p;
  try {
    le.p = 8, pu(e, t, n, a);
  } finally {
    le.p = i, G.T = l;
  }
}
function pu(e, t, n, a) {
  if (Ho) {
    var l = uc(a);
    if (l === null)
      sr(
        e,
        t,
        a,
        Go,
        n
      ), ud(e, a);
    else if (d1(
      l,
      e,
      t,
      n,
      a
    ))
      a.stopPropagation();
    else if (ud(e, a), t & 4 && -1 < f1.indexOf(e)) {
      for (; l !== null; ) {
        var i = rl(l);
        if (i !== null)
          switch (i.tag) {
            case 3:
              if (i = i.stateNode, i.current.memoizedState.isDehydrated) {
                var o = Jn(i.pendingLanes);
                if (o !== 0) {
                  var s = i;
                  for (s.pendingLanes |= 2, s.entangledLanes |= 2; o; ) {
                    var c = 1 << 31 - rt(o);
                    s.entanglements[1] |= c, o &= ~c;
                  }
                  Ot(i), !(ae & 6) && (Do = ot() + 500, Si(0));
                }
              }
              break;
            case 31:
            case 13:
              s = ma(i, 2), s !== null && Pe(s, i, 2), ms(), vu(i, 2);
          }
        if (i = uc(a), i === null && sr(
          e,
          t,
          a,
          Go,
          n
        ), i === l) break;
        l = i;
      }
      l !== null && a.stopPropagation();
    } else
      sr(
        e,
        t,
        a,
        null,
        n
      );
  }
}
function uc(e) {
  return e = _c(e), yu(e);
}
var Go = null;
function yu(e) {
  if (Go = null, e = ja(e), e !== null) {
    var t = di(e);
    if (t === null) e = null;
    else {
      var n = t.tag;
      if (n === 13) {
        if (e = sm(t), e !== null) return e;
        e = null;
      } else if (n === 31) {
        if (e = rm(t), e !== null) return e;
        e = null;
      } else if (n === 3) {
        if (t.stateNode.current.memoizedState.isDehydrated)
          return t.tag === 3 ? t.stateNode.containerInfo : null;
        e = null;
      } else t !== e && (e = null);
    }
  }
  return Go = e, null;
}
function Yg(e) {
  switch (e) {
    case "beforetoggle":
    case "cancel":
    case "click":
    case "close":
    case "contextmenu":
    case "copy":
    case "cut":
    case "auxclick":
    case "dblclick":
    case "dragend":
    case "dragstart":
    case "drop":
    case "focusin":
    case "focusout":
    case "input":
    case "invalid":
    case "keydown":
    case "keypress":
    case "keyup":
    case "mousedown":
    case "mouseup":
    case "paste":
    case "pause":
    case "play":
    case "pointercancel":
    case "pointerdown":
    case "pointerup":
    case "ratechange":
    case "reset":
    case "resize":
    case "seeked":
    case "submit":
    case "toggle":
    case "touchcancel":
    case "touchend":
    case "touchstart":
    case "volumechange":
    case "change":
    case "selectionchange":
    case "textInput":
    case "compositionstart":
    case "compositionend":
    case "compositionupdate":
    case "beforeblur":
    case "afterblur":
    case "beforeinput":
    case "blur":
    case "fullscreenchange":
    case "focus":
    case "hashchange":
    case "popstate":
    case "select":
    case "selectstart":
      return 2;
    case "drag":
    case "dragenter":
    case "dragexit":
    case "dragleave":
    case "dragover":
    case "mousemove":
    case "mouseout":
    case "mouseover":
    case "pointermove":
    case "pointerout":
    case "pointerover":
    case "scroll":
    case "touchmove":
    case "wheel":
    case "mouseenter":
    case "mouseleave":
    case "pointerenter":
    case "pointerleave":
      return 8;
    case "message":
      switch (Iy()) {
        case dm:
          return 2;
        case mm:
          return 8;
        case vo:
        case Wy:
          return 32;
        case hm:
          return 268435456;
        default:
          return 32;
      }
    default:
      return 32;
  }
}
var fc = !1, On = null, zn = null, Rn = null, ci = /* @__PURE__ */ new Map(), ui = /* @__PURE__ */ new Map(), yn = [], f1 = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
  " "
);
function ud(e, t) {
  switch (e) {
    case "focusin":
    case "focusout":
      On = null;
      break;
    case "dragenter":
    case "dragleave":
      zn = null;
      break;
    case "mouseover":
    case "mouseout":
      Rn = null;
      break;
    case "pointerover":
    case "pointerout":
      ci.delete(t.pointerId);
      break;
    case "gotpointercapture":
    case "lostpointercapture":
      ui.delete(t.pointerId);
  }
}
function Tl(e, t, n, a, l, i) {
  return e === null || e.nativeEvent !== i ? (e = {
    blockedOn: t,
    domEventName: n,
    eventSystemFlags: a,
    nativeEvent: i,
    targetContainers: [l]
  }, t !== null && (t = rl(t), t !== null && Gg(t)), e) : (e.eventSystemFlags |= a, t = e.targetContainers, l !== null && t.indexOf(l) === -1 && t.push(l), e);
}
function d1(e, t, n, a, l) {
  switch (t) {
    case "focusin":
      return On = Tl(
        On,
        e,
        t,
        n,
        a,
        l
      ), !0;
    case "dragenter":
      return zn = Tl(
        zn,
        e,
        t,
        n,
        a,
        l
      ), !0;
    case "mouseover":
      return Rn = Tl(
        Rn,
        e,
        t,
        n,
        a,
        l
      ), !0;
    case "pointerover":
      var i = l.pointerId;
      return ci.set(
        i,
        Tl(
          ci.get(i) || null,
          e,
          t,
          n,
          a,
          l
        )
      ), !0;
    case "gotpointercapture":
      return i = l.pointerId, ui.set(
        i,
        Tl(
          ui.get(i) || null,
          e,
          t,
          n,
          a,
          l
        )
      ), !0;
  }
  return !1;
}
function qg(e) {
  var t = ja(e.target);
  if (t !== null) {
    var n = di(t);
    if (n !== null) {
      if (t = n.tag, t === 13) {
        if (t = sm(n), t !== null) {
          e.blockedOn = t, Fu(e.priority, function() {
            cd(n);
          });
          return;
        }
      } else if (t === 31) {
        if (t = rm(n), t !== null) {
          e.blockedOn = t, Fu(e.priority, function() {
            cd(n);
          });
          return;
        }
      } else if (t === 3 && n.stateNode.current.memoizedState.isDehydrated) {
        e.blockedOn = n.tag === 3 ? n.stateNode.containerInfo : null;
        return;
      }
    }
  }
  e.blockedOn = null;
}
function uo(e) {
  if (e.blockedOn !== null) return !1;
  for (var t = e.targetContainers; 0 < t.length; ) {
    var n = uc(e.nativeEvent);
    if (n === null) {
      n = e.nativeEvent;
      var a = new n.constructor(
        n.type,
        n
      );
      Tr = a, n.target.dispatchEvent(a), Tr = null;
    } else
      return t = rl(n), t !== null && Gg(t), e.blockedOn = n, !1;
    t.shift();
  }
  return !0;
}
function fd(e, t, n) {
  uo(e) && n.delete(t);
}
function m1() {
  fc = !1, On !== null && uo(On) && (On = null), zn !== null && uo(zn) && (zn = null), Rn !== null && uo(Rn) && (Rn = null), ci.forEach(fd), ui.forEach(fd);
}
function Yi(e, t) {
  e.blockedOn === t && (e.blockedOn = null, fc || (fc = !0, Re.unstable_scheduleCallback(
    Re.unstable_NormalPriority,
    m1
  )));
}
var qi = null;
function dd(e) {
  qi !== e && (qi = e, Re.unstable_scheduleCallback(
    Re.unstable_NormalPriority,
    function() {
      qi === e && (qi = null);
      for (var t = 0; t < e.length; t += 3) {
        var n = e[t], a = e[t + 1], l = e[t + 2];
        if (typeof a != "function") {
          if (yu(a || n) === null)
            continue;
          break;
        }
        var i = rl(n);
        i !== null && (e.splice(t, 3), t -= 3, Qr(
          i,
          {
            pending: !0,
            data: l,
            method: n.method,
            action: a
          },
          a,
          l
        ));
      }
    }
  ));
}
function al(e) {
  function t(c) {
    return Yi(c, e);
  }
  On !== null && Yi(On, e), zn !== null && Yi(zn, e), Rn !== null && Yi(Rn, e), ci.forEach(t), ui.forEach(t);
  for (var n = 0; n < yn.length; n++) {
    var a = yn[n];
    a.blockedOn === e && (a.blockedOn = null);
  }
  for (; 0 < yn.length && (n = yn[0], n.blockedOn === null); )
    qg(n), n.blockedOn === null && yn.shift();
  if (n = (e.ownerDocument || e).$$reactFormReplay, n != null)
    for (a = 0; a < n.length; a += 3) {
      var l = n[a], i = n[a + 1], o = l[et] || null;
      if (typeof i == "function")
        o || dd(n);
      else if (o) {
        var s = null;
        if (i && i.hasAttribute("formAction")) {
          if (l = i, o = i[et] || null)
            s = o.formAction;
          else if (yu(l) !== null) continue;
        } else s = o.action;
        typeof s == "function" ? n[a + 1] = s : (n.splice(a, 3), a -= 3), dd(n);
      }
    }
}
function Xg() {
  function e(i) {
    i.canIntercept && i.info === "react-transition" && i.intercept({
      handler: function() {
        return new Promise(function(o) {
          return l = o;
        });
      },
      focusReset: "manual",
      scroll: "manual"
    });
  }
  function t() {
    l !== null && (l(), l = null), a || setTimeout(n, 20);
  }
  function n() {
    if (!a && !navigation.transition) {
      var i = navigation.currentEntry;
      i && i.url != null && navigation.navigate(i.url, {
        state: i.getState(),
        info: "react-transition",
        history: "replace"
      });
    }
  }
  if (typeof navigation == "object") {
    var a = !1, l = null;
    return navigation.addEventListener("navigate", e), navigation.addEventListener("navigatesuccess", t), navigation.addEventListener("navigateerror", t), setTimeout(n, 100), function() {
      a = !0, navigation.removeEventListener("navigate", e), navigation.removeEventListener("navigatesuccess", t), navigation.removeEventListener("navigateerror", t), l !== null && (l(), l = null);
    };
  }
}
function bu(e) {
  this._internalRoot = e;
}
vs.prototype.render = bu.prototype.render = function(e) {
  var t = this._internalRoot;
  if (t === null) throw Error(_(409));
  var n = t.current, a = ct();
  Hg(n, a, e, t, null, null);
};
vs.prototype.unmount = bu.prototype.unmount = function() {
  var e = this._internalRoot;
  if (e !== null) {
    this._internalRoot = null;
    var t = e.containerInfo;
    Hg(e.current, 2, null, e, null, null), ms(), t[sl] = null;
  }
};
function vs(e) {
  this._internalRoot = e;
}
vs.prototype.unstable_scheduleHydration = function(e) {
  if (e) {
    var t = bm();
    e = { blockedOn: null, target: e, priority: t };
    for (var n = 0; n < yn.length && t !== 0 && t < yn[n].priority; n++) ;
    yn.splice(n, 0, e), n === 0 && qg(e);
  }
};
var md = im.version;
if (md !== "19.2.4")
  throw Error(
    _(
      527,
      md,
      "19.2.4"
    )
  );
le.findDOMNode = function(e) {
  var t = e._reactInternals;
  if (t === void 0)
    throw typeof e.render == "function" ? Error(_(188)) : (e = Object.keys(e).join(","), Error(_(268, e)));
  return e = qy(t), e = e !== null ? cm(e) : null, e = e === null ? null : e.stateNode, e;
};
var h1 = {
  bundleType: 0,
  version: "19.2.4",
  rendererPackageName: "react-dom",
  currentDispatcherRef: G,
  reconcilerVersion: "19.2.4"
};
if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
  var Xi = __REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!Xi.isDisabled && Xi.supportsFiber)
    try {
      mi = Xi.inject(
        h1
      ), st = Xi;
    } catch {
    }
}
Po.createRoot = function(e, t) {
  if (!om(e)) throw Error(_(299));
  var n = !1, a = "", l = kh, i = Uh, o = Vh;
  return t != null && (t.unstable_strictMode === !0 && (n = !0), t.identifierPrefix !== void 0 && (a = t.identifierPrefix), t.onUncaughtError !== void 0 && (l = t.onUncaughtError), t.onCaughtError !== void 0 && (i = t.onCaughtError), t.onRecoverableError !== void 0 && (o = t.onRecoverableError)), t = Lg(
    e,
    1,
    !1,
    null,
    null,
    n,
    a,
    null,
    l,
    i,
    o,
    Xg
  ), e[sl] = t.current, mu(e), new bu(t);
};
Po.hydrateRoot = function(e, t, n) {
  if (!om(e)) throw Error(_(299));
  var a = !1, l = "", i = kh, o = Uh, s = Vh, c = null;
  return n != null && (n.unstable_strictMode === !0 && (a = !0), n.identifierPrefix !== void 0 && (l = n.identifierPrefix), n.onUncaughtError !== void 0 && (i = n.onUncaughtError), n.onCaughtError !== void 0 && (o = n.onCaughtError), n.onRecoverableError !== void 0 && (s = n.onRecoverableError), n.formState !== void 0 && (c = n.formState)), t = Lg(
    e,
    1,
    !0,
    t,
    n ?? null,
    a,
    l,
    c,
    i,
    o,
    s,
    Xg
  ), t.context = Bg(null), n = t.current, a = ct(), a = jc(a), l = Mn(a), l.callback = null, Tn(n, l, a), n = a, t.current.lanes = n, gi(t, n), Ot(t), e[sl] = t.current, mu(e), new vs(t);
};
Po.version = "19.2.4";
function Qg() {
  if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
    try {
      __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(Qg);
    } catch (e) {
      console.error(e);
    }
}
Qg(), Zd.exports = Po;
var g1 = Zd.exports;
const v1 = /* @__PURE__ */ new Set([
  "drawIsEnabled",
  "drawPenValue",
  "drawPenSize",
  "drawOpacity",
  "drawRimOpacity",
  "drawColormap",
  "drawIsFillOverwriting"
]);
function Dl(e) {
  return e.detail;
}
function p1(e, t) {
  const n = [], a = (o, s) => {
    e.addEventListener(o, s), n.push([o, s]);
  };
  a("change", (o) => {
    const { property: s, value: c } = Dl(o);
    v1.has(s) ? t.onDrawingOptionChange(s, c) : t.onViewerOptionChange(s, c);
  });
  const l = () => t.onVolumesChanged(e.volumes);
  a("volumeLoaded", l), a("volumeRemoved", l), a("volumeOrderChanged", l), a("frameChange", l), a("volumeUpdated", (o) => {
    const { volumeIndex: s, changes: c } = Dl(o);
    t.onVolumeUpdated(s, c), t.onVolumesChanged(e.volumes);
  });
  const i = () => t.onSurfacesChanged(e.meshes);
  return a("meshLoaded", i), a("meshRemoved", i), a("meshUpdated", i), a("drawingChanged", (o) => {
    t.onDrawingChanged(Dl(o).action);
  }), a("locationChange", (o) => t.onLocationChange(Dl(o))), a("documentLoaded", () => t.onDocumentLoaded()), a("colormapAdded", (o) => {
    t.onColormapAdded(Dl(o).name);
  }), () => {
    for (const [o, s] of n)
      e.removeEventListener(o, s);
    n.length = 0;
  };
}
const Yo = {
  axial: { sliceType: 0, showRender: va.NEVER },
  coronal: { sliceType: 1, showRender: va.NEVER },
  sagittal: { sliceType: 2, showRender: va.NEVER },
  ACS: { sliceType: 3, showRender: va.NEVER },
  ACSR: { sliceType: 3, showRender: va.ALWAYS },
  render: { sliceType: 4, showRender: va.ALWAYS }
};
function hd(e) {
  const t = e[0].toString(16).padStart(2, "0"), n = e[1].toString(16).padStart(2, "0"), a = e[2].toString(16).padStart(2, "0");
  return `#${t}${n}${a}`;
}
function qo(e) {
  let t = "";
  for (let a = 0; a < e.length; a += 8192) {
    const l = e.subarray(a, a + 8192);
    t += String.fromCharCode(...l);
  }
  return btoa(t);
}
async function Xo(e) {
  var n;
  const t = (n = new Response(e).body) == null ? void 0 : n.pipeThrough(
    new CompressionStream("gzip")
  );
  if (!t) throw new Error("gzip: no readable stream from input");
  return new Uint8Array(await new Response(t).arrayBuffer());
}
const gd = (e) => {
  let t;
  const n = /* @__PURE__ */ new Set(), a = (u, m) => {
    const g = typeof u == "function" ? u(t) : u;
    if (!Object.is(g, t)) {
      const f = t;
      t = m ?? (typeof g != "object" || g === null) ? g : Object.assign({}, t, g), n.forEach((p) => p(t, f));
    }
  }, l = () => t, s = { setState: a, getState: l, getInitialState: () => c, subscribe: (u) => (n.add(u), () => n.delete(u)) }, c = t = e(a, l, s);
  return s;
}, y1 = (e) => e ? gd(e) : gd, b1 = (e) => e;
function x1(e, t = b1) {
  const n = xe.useSyncExternalStore(
    e.subscribe,
    xe.useCallback(() => t(e.getState()), [e, t]),
    xe.useCallback(() => t(e.getInitialState()), [e, t])
  );
  return xe.useDebugValue(n), n;
}
const S1 = (e) => {
  const t = y1(e), n = (a) => x1(t, a);
  return Object.assign(n, t), n;
}, C1 = (e) => S1;
function Zg(e, t) {
  let n;
  try {
    n = e();
  } catch {
    return;
  }
  return {
    getItem: (l) => {
      var i;
      const o = (c) => c === null ? null : JSON.parse(c, void 0), s = (i = n.getItem(l)) != null ? i : null;
      return s instanceof Promise ? s.then(o) : o(s);
    },
    setItem: (l, i) => n.setItem(l, JSON.stringify(i, void 0)),
    removeItem: (l) => n.removeItem(l)
  };
}
const dc = (e) => (t) => {
  try {
    const n = e(t);
    return n instanceof Promise ? n : {
      then(a) {
        return dc(a)(n);
      },
      catch(a) {
        return this;
      }
    };
  } catch (n) {
    return {
      then(a) {
        return this;
      },
      catch(a) {
        return dc(a)(n);
      }
    };
  }
}, w1 = (e, t) => (n, a, l) => {
  let i = {
    storage: Zg(() => window.localStorage),
    partialize: (S) => S,
    version: 0,
    merge: (S, h) => ({
      ...h,
      ...S
    }),
    ...t
  }, o = !1, s = 0;
  const c = /* @__PURE__ */ new Set(), u = /* @__PURE__ */ new Set();
  let m = i.storage;
  if (!m)
    return e(
      (...S) => {
        console.warn(
          `[zustand persist middleware] Unable to update item '${i.name}', the given storage is currently unavailable.`
        ), n(...S);
      },
      a,
      l
    );
  const g = () => {
    const S = i.partialize({ ...a() });
    return m.setItem(i.name, {
      state: S,
      version: i.version
    });
  }, f = l.setState;
  l.setState = (S, h) => (f(S, h), g());
  const p = e(
    (...S) => (n(...S), g()),
    a,
    l
  );
  l.getInitialState = () => p;
  let C;
  const x = () => {
    var S, h;
    if (!m) return;
    const d = ++s;
    o = !1, c.forEach((b) => {
      var N;
      return b((N = a()) != null ? N : p);
    });
    const y = ((h = i.onRehydrateStorage) == null ? void 0 : h.call(i, (S = a()) != null ? S : p)) || void 0;
    return dc(m.getItem.bind(m))(i.name).then((b) => {
      if (b)
        if (typeof b.version == "number" && b.version !== i.version) {
          if (i.migrate) {
            const N = i.migrate(
              b.state,
              b.version
            );
            return N instanceof Promise ? N.then((O) => [!0, O]) : [!0, N];
          }
          console.error(
            "State loaded from storage couldn't be migrated since no migrate function was provided"
          );
        } else
          return [!1, b.state];
      return [!1, void 0];
    }).then((b) => {
      var N;
      if (d !== s)
        return;
      const [O, M] = b;
      if (C = i.merge(
        M,
        (N = a()) != null ? N : p
      ), n(C, !0), O)
        return g();
    }).then(() => {
      d === s && (y == null || y(C, void 0), C = a(), o = !0, u.forEach((b) => b(C)));
    }).catch((b) => {
      d === s && (y == null || y(void 0, b));
    });
  };
  return l.persist = {
    setOptions: (S) => {
      i = {
        ...i,
        ...S
      }, S.storage && (m = S.storage);
    },
    clearStorage: () => {
      m == null || m.removeItem(i.name);
    },
    getOptions: () => i,
    rehydrate: () => x(),
    hasHydrated: () => o,
    onHydrate: (S) => (c.add(S), () => {
      c.delete(S);
    }),
    onFinishHydration: (S) => (u.add(S), () => {
      u.delete(S);
    })
  }, i.skipHydration || x(), C || p;
}, A1 = w1, Fg = { dataUrl: "/data", aiUrl: "/ai" }, N1 = "freebrowse-user-settings";
function E1() {
  return {
    backend: { ...Fg },
    downloadDisabled: !1,
    persist: N1,
    readUrlParams: !0,
    exposeGlobal: !0
  };
}
let Jt = E1();
function j1(e) {
  return Jt = { ...Jt, ...e }, Jt;
}
function Za() {
  return Jt;
}
const Qo = {
  /** No backend configured (file:// builds, or an embedding host without one). */
  get serverless() {
    return Jt.backend === null;
  },
  get downloadDisabled() {
    return Jt.downloadDisabled;
  }
};
function Kg(e, t) {
  return e.replace(/\/+$/, "") + "/" + t.replace(/^\/+/, "");
}
function Jg() {
  if (Jt.backend === null)
    throw new Error(
      "FreeBrowse: no backend configured (serverless); this call should be unreachable"
    );
  return Jt.backend;
}
function Et(e = "") {
  return Kg(Jg().dataUrl, e);
}
function Nn(e = "") {
  return Kg(Jg().aiUrl, e);
}
function M1(e) {
  var l;
  const n = (((l = Jt.backend) == null ? void 0 : l.dataUrl) ?? Fg.dataUrl).replace(/\/+$/, "") + "/";
  if (e.startsWith(n)) return e.slice(n.length);
  const a = n.replace(/^\/+/, "");
  return a && e.startsWith(a) ? e.slice(a.length) : null;
}
const T1 = (e) => ({
  currentImageIndex: null,
  showUploader: !0,
  dragDropEnabled: !0,
  volumeVersion: 0,
  setCurrentImageIndex: (t) => e({ currentImageIndex: t }),
  setShowUploader: (t) => e({ showUploader: t }),
  setDragDropEnabled: (t) => e({ dragDropEnabled: t }),
  incrementVolumeVersion: () => e((t) => ({ volumeVersion: t.volumeVersion + 1 }))
}), D1 = (e) => ({
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
}), _1 = (e) => ({
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
}), O1 = (e) => ({
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
}), z1 = (e) => ({
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
}), R1 = (e) => ({
  locationData: null,
  setLocationData: (t) => e({ locationData: t })
}), k1 = (e) => ({
  aiEnabled: null,
  aiSessions: [],
  aiActiveSession: null,
  setAiEnabled: (t) => e({ aiEnabled: t }),
  setAiSessions: (t) => e({ aiSessions: t }),
  setAiActiveSession: (t) => e({ aiActiveSession: t })
}), ur = /* @__PURE__ */ new Map(), U1 = {
  getItem: (e) => {
    const t = Za().persist;
    if (t === !1) return ur.get("prefs") ?? null;
    try {
      return localStorage.getItem(t);
    } catch {
      return null;
    }
  },
  setItem: (e, t) => {
    const n = Za().persist;
    if (n === !1) {
      ur.set("prefs", t);
      return;
    }
    try {
      localStorage.setItem(n, t);
    } catch {
    }
  },
  removeItem: (e) => {
    const t = Za().persist;
    if (t === !1) {
      ur.delete("prefs");
      return;
    }
    try {
      localStorage.removeItem(t);
    } catch {
    }
  }
}, T = C1()(
  A1(
    (...e) => ({
      ...T1(...e),
      ...D1(...e),
      ..._1(...e),
      ...O1(...e),
      ...z1(...e),
      ...R1(...e),
      ...k1(...e)
    }),
    {
      name: "freebrowse-user-settings",
      // label only; the key comes from config
      // The adapter is static; it resolves the key/target on every call.
      storage: Zg(() => U1),
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
function V1(e) {
  return e ? [
    Math.round(e[0] * 255),
    Math.round(e[1] * 255),
    Math.round(e[2] * 255),
    Math.round(e[3] * 255)
  ] : [255, 255, 0, 255];
}
function L1(e) {
  const t = Object.entries(fo).find(([, n]) => n === e);
  return (t == null ? void 0 : t[0]) ?? "contrast";
}
function B1(e) {
  const t = Object.entries(Yo).find(
    ([, a]) => a.sliceType === e.sliceType && a.showRender === e.showRender
  );
  if (t) return t[0];
  const n = Object.entries(Yo).find(
    ([, a]) => a.sliceType === e.sliceType
  );
  return (n == null ? void 0 : n[0]) ?? "ACS";
}
function Ig(e, t, n) {
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
      return { dragMode: L1(n) };
    case "sliceType":
    case "showRender":
      return { viewMode: B1(e) };
    default:
      return null;
  }
}
const H1 = [
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
function G1(e) {
  const t = {};
  for (const n of H1) {
    const a = e[n];
    a !== void 0 && Object.assign(t, Ig(e, n, a));
  }
  return typeof e.crosshairWidth == "number" && (e.crosshairWidth > 0 ? (t.crosshairVisible = !0, t.crosshairWidth = e.crosshairWidth) : t.crosshairVisible = !1), t;
}
function Y1(e) {
  const t = () => T.getState(), n = (a) => t().setViewerOptions((l) => ({ ...l, ...a }));
  return {
    onViewerOptionChange(a, l) {
      const i = Ig(e, a, l);
      i && n(i);
    },
    onDrawingOptionChange(a, l) {
      const i = t();
      switch (a) {
        case "drawOpacity":
          i.setDrawingOptions((o) => ({
            ...o,
            opacity: l
          }));
          break;
        case "drawColormap":
          i.setDrawingOptions((o) => ({
            ...o,
            colormap: l
          }));
          break;
      }
    },
    onVolumesChanged(a) {
      const l = t();
      l.incrementVolumeVersion(), a.length > 0 && l.showUploader && l.setShowUploader(!1);
    },
    onVolumeUpdated() {
      t().incrementVolumeVersion();
    },
    onSurfacesChanged() {
      queueMicrotask(() => {
        const a = e.meshes;
        t().setSurfaces(
          a.map((l, i) => ({
            id: `surface-${i}`,
            name: l.name || `Surface ${i + 1}`,
            // niivue-mono does not render a mesh `visible` flag, so FreeBrowse
            // models surface visibility via opacity (0 == hidden), like volumes.
            visible: (l.opacity ?? 1) > 0,
            opacity: l.opacity ?? 1,
            rgba255: V1(l.color),
            shaderType: l.shaderType || "phong"
          }))
        ), t().incrementLayerVersion();
      });
    },
    onDrawingChanged() {
      const a = e.drawingVolume != null;
      t().setDrawingOptions((l) => ({ ...l, enabled: a })), t().incrementVolumeVersion();
    },
    onLocationChange(a) {
      const l = a;
      if (!l) return;
      const i = (l.values ?? []).map((o, s) => {
        const c = o.vox ?? [0, 0, 0];
        return {
          name: o.name || `Volume ${s + 1}`,
          voxel: [
            Math.round(c[0]),
            Math.round(c[1]),
            Math.round(c[2])
          ],
          value: o.value ?? 0
        };
      });
      t().setLocationData({ mm: l.mm ?? [0, 0, 0], voxels: i });
    },
    onDocumentLoaded() {
      t().incrementVolumeVersion(), t().incrementLayerVersion();
    },
    onColormapAdded() {
    }
  };
}
function xu(e, t = "none") {
  const n = T((A) => A.viewerOptions), a = T((A) => A.setViewerOptions), l = v.useRef(null), i = v.useRef(null), o = v.useCallback(() => {
    l.current && clearTimeout(l.current), l.current = setTimeout(() => {
      e.current && e.current.updateGLVolume();
    }, 100);
  }, [e]);
  v.useEffect(() => () => {
    l.current && clearTimeout(l.current), i.current && clearTimeout(i.current);
  }, []);
  const s = v.useCallback(() => {
    const A = e.current;
    if (!A) return;
    const w = T.getState().viewerOptions;
    A.crosshairWidth = w.crosshairVisible ? w.crosshairWidth : 0, A.crosshairGap = w.crosshairGap, A.crosshairColor = w.crosshairColor, A.rulerWidth = w.rulerWidth, A.isRulerVisible = w.rulerVisible, A.volumeIsNearestInterpolation = !w.interpolateVoxels, A.secondaryDragMode = fo[w.dragMode], A.volumeOutlineWidth = w.overlayOutlineWidth, A.isColorbarVisible = w.isColorbar, A.isRadiological = w.isRadiologicalConvention;
    const E = Yo[w.viewMode];
    E ? (A.showRender = E.showRender, A.sliceType = E.sliceType) : A.sliceType = 0;
  }, [e]), c = v.useCallback(() => {
    const A = e.current;
    if (!A) return;
    const w = G1(A);
    Object.keys(w).length !== 0 && a((E) => ({ ...E, ...w }));
  }, [e, a]), u = v.useRef(!1);
  v.useEffect(() => {
    t === "none" || u.current || !e.current || (u.current = !0, t === "apply" ? s() : c());
  }, [t, s, c, e]);
  const m = v.useCallback(
    (A) => {
      const w = e.current, E = Yo[A];
      !w || !E || (w.showRender = E.showRender, w.sliceType = E.sliceType);
    },
    [e]
  ), g = v.useCallback(
    (A) => {
      e.current && (e.current.secondaryDragMode = fo[A]);
    },
    [e]
  ), f = v.useCallback(
    (A) => {
      a((E) => ({ ...E, crosshairWidth: A }));
      const w = e.current;
      w && (w.crosshairWidth = n.crosshairVisible ? A : 0);
    },
    [e, a, n.crosshairVisible]
  ), p = v.useCallback(
    (A) => {
      a((E) => ({ ...E, crosshairVisible: A }));
      const w = e.current;
      w && (w.crosshairWidth = A ? n.crosshairWidth : 0);
    },
    [e, a, n.crosshairWidth]
  ), C = v.useCallback(
    (A) => {
      e.current && (e.current.crosshairGap = A);
    },
    [e]
  ), x = v.useCallback(
    (A) => {
      const w = A.replace("#", ""), E = parseInt(w.substr(0, 2), 16) / 255, R = parseInt(w.substr(2, 2), 16) / 255, k = parseInt(w.substr(4, 2), 16) / 255, V = n.crosshairColor[3];
      i.current && clearTimeout(i.current), i.current = setTimeout(() => {
        e.current && (e.current.crosshairColor = [E, R, k, V]);
      }, 50);
    },
    [n.crosshairColor, e]
  ), S = v.useCallback(
    (A) => {
      e.current && (e.current.volumeIsNearestInterpolation = !A);
    },
    [e]
  ), h = v.useCallback(
    (A) => {
      e.current && (e.current.rulerWidth = A);
    },
    [e]
  ), d = v.useCallback(
    (A) => {
      e.current && (e.current.isRulerVisible = A);
    },
    [e]
  ), y = v.useCallback(
    (A) => {
      e.current && (e.current.isColorbarVisible = A);
    },
    [e]
  ), b = v.useCallback(
    (A) => {
      e.current && (e.current.isRadiological = A);
    },
    [e]
  ), N = v.useCallback(
    (A) => {
      a((w) => ({ ...w, sagittalNoseLeft: A }));
    },
    [a]
  ), O = v.useCallback(
    (A) => {
      e.current && (e.current.volumeOutlineWidth = A);
    },
    [e]
  ), M = v.useCallback(() => {
    const A = e.current;
    A && (A.scaleMultiplier = 1, A.pan2Dxyzmm = [0, 0, 0, 1], A.crosshairPos = [0.5, 0.5, 0.5], A.azimuth = 110, A.elevation = 10, (A.volumes ?? []).forEach((w, E) => {
      w.robustMin !== void 0 && w.robustMax !== void 0 && A.setVolume(E, { calMin: w.robustMin, calMax: w.robustMax });
    }));
  }, [e]);
  return {
    viewerOptions: n,
    setViewerOptions: a,
    applyViewerOptions: s,
    syncViewerOptionsFromNiiVue: c,
    debouncedGLUpdate: o,
    handleViewMode: m,
    handleDragModeChange: g,
    handleCrosshairWidthChange: f,
    handleCrosshairGapChange: C,
    handleInterpolateVoxelsChange: S,
    handleCrosshairVisibleChange: p,
    handleCrosshairColorChange: x,
    handleRulerWidthChange: h,
    handleRulerVisibleChange: d,
    handleOverlayOutlineWidthChange: O,
    handleColorbarChange: y,
    handleRadiologicalChange: b,
    handleSagittalNoseLeftChange: N,
    resetViewAndContrast: M
  };
}
const Wg = /* @__PURE__ */ new Set(["freesurfer", "roi_i256"]);
async function q1(e) {
  const t = e.volumes || [];
  for (let n = 0; n < t.length; n++) {
    const a = t[n], l = typeof a.colormap == "string" ? a.colormap : "";
    !l || a.colormapLabel || Wg.has(l.toLowerCase()) && await e.setColormapLabel(n, l);
  }
}
function X1(e, t, n) {
  const a = T((z) => z.currentImageIndex), l = T(
    (z) => z.setCurrentImageIndex
  ), i = T((z) => z.volumeVersion), o = T(
    (z) => z.incrementVolumeVersion
  ), s = T((z) => z.volumeToRemove), c = T((z) => z.setVolumeToRemove), u = T(
    (z) => z.skipRemoveConfirmation
  ), m = T((z) => z.setRemoveDialogOpen), g = T((z) => z.surfaceToRemove), f = T((z) => z.setSurfaceToRemove), p = T((z) => z.drawingOptions), C = T((z) => z.setDrawingOptions), x = T((z) => z.setActiveTab), S = v.useCallback(() => {
    const z = e.current;
    return z ? z.volumes || [] : [];
  }, [e, i]), h = v.useCallback(
    (z) => {
      const j = e.current;
      if (!j) return;
      const U = j.volumes.findIndex((Q) => Q.id === z);
      if (U < 0) return;
      const D = j.volumes[U];
      j.setVolume(U, { visible: D.visible === !1 }), o();
    },
    [e, o]
  ), d = v.useCallback(
    (z) => {
      const j = e.current;
      a === null || !j || !j.volumes[a] || (j.setVolume(a, { opacity: z }), o());
    },
    [a, e, o]
  ), y = v.useCallback(
    (z) => {
      const j = e.current;
      if (a === null || !j || !j.volumes[a])
        return;
      const U = j.volumes[a].id;
      U && (j.setFrame4D(U, z), o());
    },
    [a, e, o]
  ), b = v.useCallback(
    (z) => {
      const j = e.current;
      a === null || !j || !j.volumes[a] || j.setVolume(a, { calMin: z });
    },
    [a, e]
  ), N = v.useCallback(
    (z) => {
      const j = e.current;
      a === null || !j || !j.volumes[a] || j.setVolume(a, { calMax: z });
    },
    [a, e]
  ), O = v.useCallback(
    (z) => {
      const j = z.target.value, U = e.current;
      a === null || !U || !U.volumes[a] || (U.setVolume(a, { colormap: j }), Wg.has(j.toLowerCase()) ? U.setColormapLabel(a, j) : U.setColormapLabel(a, null));
    },
    [a, e]
  ), M = v.useCallback(() => {
    const z = e.current;
    a === null || !z || !z.volumes[a] || a !== 0 && (z.moveVolumeDown(a), l(a - 1), o());
  }, [a, e, l, o]), A = v.useCallback(() => {
    const z = e.current;
    a === null || !z || !z.volumes[a] || a >= z.volumes.length - 1 || (z.moveVolumeUp(a), l(a + 1), o());
  }, [a, e, l, o]), w = v.useCallback(
    (z) => {
      const j = e.current;
      !j || !j.volumes[z] || (j.removeVolume(z), o(), a === z ? z > 0 ? l(z - 1) : j.volumes.length > 0 ? l(0) : l(null) : a !== null && a > z && l(a - 1));
    },
    [a, e, o, l]
  ), E = v.useCallback(
    (z) => {
      u ? w(z) : (c(z), m(!0));
    },
    [
      u,
      w,
      c,
      m
    ]
  ), R = v.useCallback(
    async (z) => {
      const j = e.current;
      if (!j || !j.volumes[z]) return;
      const U = j.volumes[z], D = U.colormap, Q = (U.name || "edit.nii").replace(
        /\.gz$/i,
        ""
      ), I = await j.saveVolume({
        filename: "",
        volumeByIndex: z
      });
      if (!(I instanceof Uint8Array)) return;
      const Be = new File([I], Q, {
        type: "application/octet-stream"
      });
      if (await j.removeVolume(z), await j.loadDrawing(Be), D && (j.drawColormap = D), j.drawPenValue = p.penErases ? 0 : p.penValue, j.drawPenFilled = p.penFill, j.drawIsFillOverwriting = p.penFill, j.drawIsEnabled = !0, C((we) => ({ ...we, mode: "pen" })), a !== null && a >= z) {
        const we = Math.max(0, a - 1);
        l(j.volumes.length > 0 ? we : null);
      }
      x("drawing");
    },
    [
      e,
      a,
      p.penErases,
      p.penValue,
      p.penFill,
      l,
      C,
      x
    ]
  ), k = v.useCallback(
    (z) => {
      const j = e.current;
      if (!j || !j.volumes[z]) return !1;
      const U = j.volumes[z], D = j.volumes[0];
      if (!D || U === D || !U.hdr || !D.hdr || U.hdr.datatypeCode !== 2) return !1;
      const Q = U.hdr.dims, I = D.hdr.dims;
      if (Q[1] !== I[1] || Q[2] !== I[2] || Q[3] !== I[3] || !U.hdr.affine || !D.hdr.affine) return !1;
      const Be = U.hdr.affine, we = D.hdr.affine;
      for (let ie = 0; ie < 4; ie++)
        for (let ne = 0; ne < 4; ne++) {
          const Qe = ie * 4 + ne, ln = Number(Be[Qe]), ye = Number(we[Qe]);
          if (Math.abs(ln - ye) > 1e-4)
            return !1;
        }
      return !0;
    },
    [e]
  ), V = v.useCallback(() => {
    s !== null && w(s), g !== null && n(g), m(!1), c(null), f(null);
  }, [
    s,
    w,
    g,
    n,
    m,
    c,
    f
  ]), J = v.useCallback(() => {
    m(!1), c(null), f(null);
  }, [m, c, f]);
  return {
    getVolumes: S,
    toggleImageVisibility: h,
    handleOpacityChange: d,
    handleFrameChange: y,
    handleContrastMinChange: b,
    handleContrastMaxChange: N,
    handleColormapChange: O,
    handleMoveVolumeUp: M,
    handleMoveVolumeDown: A,
    removeVolume: w,
    handleRemoveVolumeClick: E,
    handleEditVolume: R,
    canEditVolume: k,
    handleConfirmRemove: V,
    handleCancelRemove: J
  };
}
function Q1(e, t) {
  const n = T((x) => x.currentSurfaceIndex), a = T(
    (x) => x.setCurrentSurfaceIndex
  );
  T((x) => x.surfaceToRemove);
  const l = T((x) => x.setSurfaceToRemove), i = T(
    (x) => x.skipRemoveConfirmation
  ), o = T((x) => x.setRemoveDialogOpen), s = v.useRef(null);
  v.useEffect(() => () => {
    s.current && clearTimeout(s.current);
  }, []);
  const c = v.useCallback(() => {
  }, []), u = v.useCallback(
    // Index-based: niivue-mono meshes have no stable id (unlike volumes), so
    // all mesh ops are addressed by index.
    (x) => {
      const S = e.current, h = S == null ? void 0 : S.meshes[x];
      if (!S || !h) return;
      const d = (h.opacity ?? 1) > 0;
      S.setMesh(x, { opacity: d ? 0 : 1 });
    },
    [e]
  ), m = v.useCallback(
    (x) => {
      const S = e.current;
      !S || !S.meshes[x] || (S.removeMesh(x), n === x ? x > 0 ? a(x - 1) : S.meshes.length > 1 ? a(0) : a(null) : n !== null && n > x && a(n - 1));
    },
    [e, n, a]
  ), g = v.useCallback(
    (x) => {
      i ? m(x) : (l(x), o(!0));
    },
    [
      i,
      m,
      l,
      o
    ]
  ), f = v.useCallback(
    (x) => {
      const S = e.current;
      n === null || !S || !S.meshes[n] || S.setMesh(n, { opacity: x });
    },
    [n, e]
  ), p = v.useCallback(
    (x) => {
      const S = e.current;
      if (n === null || !S || !S.meshes[n])
        return;
      const h = parseInt(x.slice(1, 3), 16), d = parseInt(x.slice(3, 5), 16), y = parseInt(x.slice(5, 7), 16), b = n;
      s.current && clearTimeout(s.current), s.current = setTimeout(() => {
        e.current && e.current.setMesh(b, { rgba255: [h, d, y, 255] });
      }, 50);
    },
    [n, e]
  ), C = v.useCallback(
    (x) => {
      const S = e.current;
      n === null || !S || !S.meshes[n] || S.setMesh(n, { shaderType: x });
    },
    [n, e]
  );
  return {
    updateSurfaceDetails: c,
    toggleSurfaceVisibility: u,
    removeSurface: m,
    handleRemoveSurfaceClick: g,
    handleSurfaceOpacityChange: f,
    handleSurfaceColorChange: p,
    handleMeshShaderChange: C
  };
}
function Z1(e) {
  const t = T((h) => h.currentSurfaceIndex), n = T((h) => h.selectedLayerIndex), a = T(
    (h) => h.setSelectedLayerIndex
  ), l = T((h) => h.layerVersion), i = v.useRef(null);
  v.useEffect(() => {
    a(null);
  }, [t, a]);
  const o = v.useCallback(() => {
    const h = e.current;
    return h && t !== null && h.meshes[t] ? h.meshes[t].layers || [] : [];
  }, [e, t, l]), s = v.useCallback(
    async (h) => {
      const d = e.current;
      if (!d || t === null || !d.meshes[t])
        return;
      await d.addMeshLayer(t, {
        url: h,
        name: h.name,
        opacity: 0.5
      });
      const y = d.meshes[t].layers || [];
      a(y.length - 1);
    },
    [e, t, a]
  ), c = v.useCallback(
    (h) => {
      const d = e.current;
      !d || t === null || !d.meshes[t] || (d.removeMeshLayer(t, h), n === h ? a(null) : n !== null && n > h && a(n - 1));
    },
    [e, t, n, a]
  ), u = v.useCallback(
    (h) => {
      const d = e.current;
      !d || t === null || n === null || !d.meshes[t] || d.setMeshLayerProperty(
        t,
        n,
        h
      );
    },
    [e, t, n]
  ), m = v.useCallback(
    (h) => u({ opacity: h }),
    [u]
  ), g = v.useCallback(
    (h) => u({ calMin: h }),
    [u]
  ), f = v.useCallback(
    (h) => u({ calMax: h }),
    [u]
  ), p = v.useCallback(
    async (h) => u({ colormap: h }),
    [u]
  ), C = v.useCallback(
    // niivue-mono has no `useNegativeCmap` boolean; enabling a negative colormap
    // means setting `colormapNegative` to a colormap name ('' disables).
    async (h) => u({ colormapNegative: h ? "winter" : "" }),
    [u]
  ), x = v.useCallback(() => {
    var h;
    (h = i.current) == null || h.click();
  }, []), S = v.useCallback(
    async (h) => {
      if (h.target.files && h.target.files.length > 0) {
        const d = Array.from(h.target.files);
        for (const y of d)
          await s(y);
      }
      h.target.value = "";
    },
    [s]
  );
  return {
    layerFileInputRef: i,
    getLayers: o,
    addLayerFromFile: s,
    removeLayer: c,
    handleLayerOpacityChange: m,
    handleLayerCalMinChange: g,
    handleLayerCalMaxChange: f,
    handleLayerColormapChange: p,
    handleLayerUseNegativeCmapChange: C,
    handleAddLayerFiles: x,
    handleLayerFileChange: S
  };
}
function F1(e, t) {
  const n = T((h) => h.drawingOptions), a = T((h) => h.setDrawingOptions), l = T((h) => h.setActiveTab), i = v.useCallback(() => {
    const h = e.current;
    !h || !h.volumes[0] || (h.createEmptyDrawing(), h.drawColormap = n.colormap, h.drawOpacity = n.opacity, h.drawPenFilled = n.penFill, h.drawIsEnabled = !1, a((d) => ({ ...d, mode: "none" })), l("drawing"));
  }, [
    e,
    n.colormap,
    n.opacity,
    n.penFill,
    a,
    l
  ]), o = v.useCallback(
    (h) => {
      a((y) => ({ ...y, mode: h }));
      const d = e.current;
      d && (h === "pen" ? (d.drawPenValue = n.penErases ? 0 : n.penValue, d.drawPenFilled = n.penFill, d.drawIsFillOverwriting = n.penFill, d.drawIsEnabled = !0) : d.drawIsEnabled = !1);
    },
    [
      e,
      n.penErases,
      n.penValue,
      n.penFill,
      a
    ]
  ), s = v.useCallback(
    (h) => {
      a((y) => ({ ...y, penValue: h }));
      const d = e.current;
      d && n.mode === "pen" && !n.penErases && (d.drawPenValue = h);
    },
    [e, n.mode, n.penErases, a]
  ), c = v.useCallback(
    (h) => {
      a((y) => ({ ...y, penErases: h }));
      const d = e.current;
      d && n.mode === "pen" && (d.drawPenValue = h ? 0 : n.penValue);
    },
    [e, n.mode, n.penValue, a]
  ), u = v.useCallback(
    // store-owned: drawPenFilled is a plain field (no event to mirror). "Pen
    // fill" = flood-fill the enclosed shape (drawPenFilled) AND overwrite
    // existing labels (drawIsFillOverwriting), matching old FreeBrowse.
    (h) => {
      a((y) => ({ ...y, penFill: h }));
      const d = e.current;
      d && (d.drawPenFilled = h, d.drawIsFillOverwriting = h);
    },
    [e, a]
  ), m = v.useCallback(
    // event-mirrored (opacity follows drawOpacity)
    (h) => {
      const d = e.current;
      d && (d.drawOpacity = h);
    },
    [e]
  ), g = v.useCallback(
    // event-mirrored (colormap follows drawColormap). Options come from
    // nv.drawingColormapNames() — the `_`-prefixed draw LUTs, not nv.colormaps.
    (h) => {
      const d = e.current;
      d && (d.drawColormap = h.target.value);
    },
    [e]
  ), f = v.useCallback(() => {
    const h = e.current;
    h && h.drawUndo();
  }, [e]), p = v.useCallback(
    (h) => a((d) => ({ ...d, magicWand2dOnly: h })),
    [a]
  ), C = v.useCallback(
    (h) => a((d) => ({ ...d, magicWandMaxDistanceMM: h })),
    [a]
  ), x = v.useCallback(
    (h) => a((d) => ({
      ...d,
      magicWandThresholdPercent: h
    })),
    [a]
  ), S = v.useCallback(async () => {
    const h = e.current;
    if (!h || !h.drawingVolume) return;
    const d = await h.saveVolume({
      filename: "",
      isSaveDrawing: !0,
      volumeByIndex: 0
    });
    if (!(d instanceof Uint8Array)) return;
    const y = n.filename.replace(/\.gz$/i, ""), b = new File([d], y, { type: "application/octet-stream" });
    h.drawIsEnabled = !1, h.closeDrawing(), await h.addVolume({ url: b, name: y });
    const N = h.volumes.length - 1;
    N >= 0 && (await h.setVolume(N, { colormap: "roi_i256" }), await h.setColormapLabel(N, "roi_i256")), a((O) => ({ ...O, mode: "none" })), l("sceneDetails");
  }, [e, n.filename, a, l]);
  return {
    handleCreateDrawingLayer: i,
    handleDrawingColormapChange: g,
    handleDrawModeChange: o,
    handlePenFillChange: u,
    handlePenErasesChange: c,
    handlePenValueChange: s,
    handleDrawingOpacityChange: m,
    handleMagicWand2dOnlyChange: p,
    handleMagicWandMaxDistanceChange: C,
    handleMagicWandThresholdChange: x,
    handleDrawUndo: f,
    handleSaveDrawing: S
  };
}
const $g = '(function(){"use strict";const X={AXIAL:0,CORONAL:1};function ct(t,e){const{dimX:o,dimY:r,dimZ:s}=e;return t===X.AXIAL?{w:o,h:r,depth:s}:t===X.CORONAL?{w:o,h:s,depth:r}:{w:r,h:s,depth:o}}function Y(t,e,o,r){return t+e*r.dimX+o*r.dimX*r.dimY}function j(t,e,o,r,s){if(!s)return Y(t,e,o,r);const{img2RASstep:i,img2RASstart:n}=s;return n[0]+t*i[0]+n[1]+e*i[1]+n[2]+o*i[2]}function U(t,e,o,r){const{dimX:s,dimY:i,dimZ:n}=r;if(e===X.AXIAL){const c=new Float32Array(s*i),f=t*s*i;for(let a=0;a<c.length;a++)c[a]=o[f+a];return c}if(e===X.CORONAL){const c=new Float32Array(s*n);for(let f=0;f<n;f++)for(let a=0;a<s;a++)c[a+f*s]=o[Y(a,t,f,r)];return c}const l=new Float32Array(i*n);for(let c=0;c<n;c++)for(let f=0;f<i;f++)l[f+c*i]=o[Y(t,f,c,r)];return l}function J(t,e,o,r,s,i){const{dimX:n,dimY:l,dimZ:c}=r,f=1/s;if(e===X.AXIAL){const u=new Float32Array(n*l);for(let h=0;h<l;h++)for(let p=0;p<n;p++)u[p+h*n]=o[j(p,h,t,r,i)]*f;return u}if(e===X.CORONAL){const u=new Float32Array(n*c);for(let h=0;h<c;h++)for(let p=0;p<n;p++)u[p+h*n]=o[j(p,t,h,r,i)]*f;return u}const a=new Float32Array(l*c);for(let u=0;u<c;u++)for(let h=0;h<l;h++)a[h+u*l]=o[j(t,h,u,r,i)]*f;return a}function wt(t,e,o,r,s,i,n){const{dimX:l,dimY:c,dimZ:f}=s;if(o===X.AXIAL){const a=e*l*c;for(let u=0;u<t.length;u++)t[u]>=i&&(r[a+u]=n)}else if(o===X.CORONAL)for(let a=0;a<f;a++)for(let u=0;u<l;u++)t[u+a*l]>=i&&(r[Y(u,e,a,s)]=n);else for(let a=0;a<f;a++)for(let u=0;u<c;u++)t[u+a*c]>=i&&(r[Y(e,u,a,s)]=n)}function ft(t,e,o){if(e<3||o<3)return;const r=new Float32Array(t.length);for(let s=0;s<o;s++)for(let i=0;i<e;i++){const n=i+s*e;r[n]=i===0||i===e-1?t[n]:(t[n-1]+2*t[n]+t[n+1])*.25}for(let s=0;s<o;s++)for(let i=0;i<e;i++){const n=i+s*e;t[n]=s===0||s===o-1?r[n]:(r[n-e]+2*r[n]+r[n+e])*.25}}function pt(t,e,o,r){const s=Math.abs(o-t),i=Math.abs(o-e),n=Math.exp(-s*s/(2*r*r)),l=Math.exp(-i*i/(2*r*r)),c=n+l;return c<1e-6?.5:n/c}function bt(t,e,o){const{depth:r}=ct(t,o);let s=-1,i=-1;for(let n=0;n<r;n++){const l=U(n,t,e,o);let c=!1;for(let f=0;f<l.length;f++)if(l[f]>0){c=!0;break}c&&(s===-1&&(s=n),i=n)}return s===-1?null:{first:s,last:i}}function xt(t,e,o,r,s,i,n,l){const c=n.sliceType??X.AXIAL,{w:f,h:a,depth:u}=ct(c,e),h=u-1,p={intensityWeight:n.intensityWeight??.7,binaryThreshold:n.binaryThreshold??.375,intensitySigma:n.intensitySigma??.1,applySmoothingToSlices:n.applySmoothingToSlices??!0,useIntensityGuided:n.useIntensityGuided??!1};if(s!==void 0&&i!==void 0){if(s>=i)throw new Error("Low slice index must be less than high slice index");if(s<0||i>h)throw new Error(`Slice indices out of bounds [0, ${h}]`)}const C=new Map;for(let b=0;b<=h;b++){const N=U(b,c,t,e);for(let y=0;y<N.length;y++){const g=N[y];if(g>0){const x=C.get(g);x?(x.min=Math.min(x.min,b),x.max=Math.max(x.max,b)):C.set(g,{min:b,max:b})}}}for(const[b,N]of C){const y=s!==void 0?Math.max(s,N.min):N.min,g=i!==void 0?Math.min(i,N.max):N.max;if(y>=g||g-y<2)continue;const x=U(y,c,t,e),O=U(g,c,t,e),M=new Float32Array(x.length),I=new Float32Array(O.length);for(let A=0;A<x.length;A++)M[A]=x[A]===b?1:0,I[A]=O[A]===b?1:0;p.applySmoothingToSlices&&(ft(M,f,a),ft(I,f,a));for(let A=y+1;A<g;A++){const E=new Float32Array(f*a),d=(A-y)/(g-y),w=1-d;if(p.useIntensityGuided&&o){const m=J(y,c,o,e,r,l),v=J(g,c,o,e,r,l),nt=J(A,c,o,e,r,l),Z=p.intensityWeight;for(let F=0;F<M.length;F++)if(M[F]>0||I[F]>0){const et=pt(m[F],v[F],nt[F],p.intensitySigma),D=Z*et+(1-Z)*w,ot=1-D;E[F]=M[F]*D+I[F]*ot}else E[F]=M[F]*w+I[F]*d}else for(let m=0;m<M.length;m++)E[m]=M[m]*w+I[m]*d;wt(E,A,c,t,e,p.binaryThreshold,b)}}return t}function k(t,e,o,r){return t+e*r.dimX+o*r.dimX*r.dimY}function lt(t,e,o,r,s){if(!s)return k(t,e,o,r);const{img2RASstep:i,img2RASstart:n}=s;return n[0]+t*i[0]+n[1]+e*i[1]+n[2]+o*i[2]}const K=[[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]],at=[[-1,-1,0],[1,-1,0],[-1,1,0],[1,1,0],[0,-1,-1],[0,1,-1],[-1,0,-1],[1,0,-1],[0,-1,1],[0,1,1],[-1,0,1],[1,0,1]],Mt=[[-1,-1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],[-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]];function ut(t){return t>=26?[...K,...at,...Mt]:t>=18?[...K,...at]:[...K]}function dt(t,e,o,r,s={},i,n){const{tolerance:l=0,thresholdMode:c="symmetric",percent:f=0,calMin:a=0,calMax:u=1,connectivity:h=6,maxDistanceMM:p=Number.POSITIVE_INFINITY,is2D:C=!1,sliceAxis:b=0,penValue:N=1}=s,{dimX:y,dimY:g,dimZ:x}=o,O=y*g*x,[M,I,A]=t;if(M<0||I<0||A<0||M>=y||I>=g||A>=x)return{filledCount:0,seedIntensity:0,intensityMin:0,intensityMax:0};const E=lt(M,I,A,o,i),d=Number(r[E]);let w,m,v;if(s.intensityMin!==void 0&&s.intensityMax!==void 0)w=s.intensityMin,m=s.intensityMax;else{let L=c==="auto"?"symmetric":c;switch(c==="auto"&&(v=d>(a+u)*.5,L=v?"bright":"dark"),L){case"percent":{const S=d===0?.01:d;w=S*(1-f),m=S*(1+f);break}case"bright":if(f>0){const S=d===0?.01:d;w=S*(1-f),m=S*(1+f)}else l>0?(w=d,m=d+l):(w=d,m=Number.POSITIVE_INFINITY);break;case"dark":if(f>0){const S=d===0?.01:d;w=S*(1-f),m=S*(1+f)}else l>0?(w=d-l,m=d):(w=Number.NEGATIVE_INFINITY,m=d);break;default:w=d-l,m=d+l;break}}const nt=ut(h),Z=n?n[0]:1,F=n?n[1]:1,et=n?n[2]:1,D=p*p;function ot(L,S,H){if(!Number.isFinite(D))return!0;const P=(L-M)*Z,q=(S-I)*F,$=(H-A)*et;return P*P+q*q+$*$<=D}let z=-1,G=-1;C&&(b===0?(z=2,G=A):b===1?(z=1,G=I):b===2&&(z=0,G=M));const it=new Uint8Array(O),yt=k(M,I,A,o);if(d<w||d>m)return{filledCount:0,seedIntensity:d,intensityMin:w,intensityMax:m,isBright:v};const rt=[yt];it[yt]=1;let gt=0;for(;rt.length>0;){const L=rt.shift(),S=Math.floor(L/(y*g)),H=Math.floor((L-S*y*g)/y),P=L-S*y*g-H*y;e[L]=N,gt++;for(const[q,$,St]of nt){const B=P+q,W=H+$,T=S+St;if(B<0||W<0||T<0||B>=y||W>=g||T>=x||z>=0&&(z===0?B:z===1?W:T)!==G)continue;const st=k(B,W,T,o);if(it[st]||(it[st]=1,!ot(B,W,T)))continue;const At=Number(r[lt(B,W,T,o,i)]);At<w||At>m||rt.push(st)}}return{filledCount:gt,seedIntensity:d,intensityMin:w,intensityMax:m,isBright:v}}function It(t,e,o,r,s=6){const{dimX:i,dimY:n,dimZ:l}=o,[c,f,a]=t;if(c<0||f<0||a<0||c>=i||f>=n||a>=l)return 0;const u=k(c,f,a,o),h=e[u];if(h===r||h===0)return 0;const p=i*n*l,C=new Uint8Array(p),b=ut(s),N=[u];C[u]=1;let y=0;for(;N.length>0;){const g=N.shift();e[g]=r,y++;const x=Math.floor(g/(i*n)),O=Math.floor((g-x*i*n)/i),M=g-x*i*n-O*i;for(const[I,A,E]of b){const d=M+I,w=O+A,m=x+E;if(d<0||w<0||m<0||d>=i||w>=n||m>=l)continue;const v=k(d,w,m,o);C[v]||(C[v]=1,e[v]===h&&N.push(v))}}return y}const R=self.postMessage.bind(self),Ft={findBoundarySlices(t){const e=t.sliceType,o=new Uint8Array(t.drawBitmap),r=t.dims;return{result:bt(e,o,r)}},interpolateMaskSlices(t){const e=new Uint8Array(t.drawBitmap),o=t.dims,r=t.imageData?new Float32Array(t.imageData):null,s=t.maxVal??1,i=t.sliceIndexLow,n=t.sliceIndexHigh,l=t.options??{},c=t.rasMap??void 0;return{drawBitmap:xt(e,o,r,s,i,n,l,c).buffer}},magicWand(t){const e=t.seed,o=new Uint8Array(t.drawBitmap),r=t.dims,s=new Float32Array(t.imageData),i=t.options??{},n=t.rasMap??void 0,l=t.voxelSizeMM??void 0,c=dt(e,o,r,s,i,n,l);return{drawBitmap:o.buffer,result:c}},magicWandFromBitmap(t){const e=t.seed,o=new Uint8Array(t.drawBitmap),r=t.dims,s=t.newColor??0,i=t.connectivity??6,n=It(e,o,r,s,i);return{drawBitmap:o.buffer,count:n}}};let V=null,Q=null,_=null,tt=null,mt,ht;self.onmessage=t=>{const e=t.data;if(e.type==="initShared"){V=new Uint8Array(e.workingBuffer),Q=new Float32Array(e.imageBuffer),_=new Uint8Array(e.committedBuffer),tt=e.dims,mt=e.rasMap??void 0,ht=e.voxelSizeMM??void 0,R({type:"initSharedDone"});return}if(e.type==="updateCommitted"){_=new Uint8Array(e.committed);return}if(e.type==="magicWandShared"){if(!V||!Q||!_||!tt){R({type:"magicWandSharedResult",error:"Not initialized",gen:e.gen});return}V.set(_);const n=dt(e.seed,V,tt,Q,e.options??{},mt,ht);R({type:"magicWandSharedResult",result:n,gen:e.gen});return}const{_wbId:o,name:r,...s}=e,i=Ft[r];if(!i){R({_wbId:o,_wbError:`Unknown operation: ${r}`});return}try{const n=i(s),l=[];for(const c of Object.values(n))c instanceof ArrayBuffer&&l.push(c);R({_wbId:o,...n},l)}catch(n){R({_wbId:o,_wbError:n instanceof Error?n.message:String(n)})}}})();\n', vd = typeof self < "u" && self.Blob && new Blob([$g], { type: "text/javascript;charset=utf-8" });
function K1(e) {
  let t;
  try {
    if (t = vd && (self.URL || self.webkitURL).createObjectURL(vd), !t) throw "";
    const n = new Worker(t, {
      name: e == null ? void 0 : e.name
    });
    return n.addEventListener("error", () => {
      (self.URL || self.webkitURL).revokeObjectURL(t);
    }), n;
  } catch {
    return new Worker(
      "data:text/javascript;charset=utf-8," + encodeURIComponent($g),
      {
        name: e == null ? void 0 : e.name
      }
    );
  } finally {
    t && (self.URL || self.webkitURL).revokeObjectURL(t);
  }
}
function J1(e) {
  if (e instanceof Float32Array) return e;
  const t = new Float32Array(e.length);
  for (let n = 0; n < e.length; n++) t[n] = e[n];
  return t;
}
let fr = null;
function I1() {
  return fr || (fr = new gy(() => new K1())), fr;
}
async function Pg(e, t, n, a, l, i) {
  const o = t.buffer.slice(
    t.byteOffset,
    t.byteOffset + t.byteLength
  ), s = J1(a), c = s.buffer.slice(
    s.byteOffset,
    s.byteOffset + s.byteLength
  ), u = [o, c], m = await I1().execute(
    {
      name: "magicWand",
      seed: e,
      drawBitmap: o,
      dims: n,
      imageData: c,
      options: l ?? {},
      rasMap: null,
      voxelSizeMM: i ?? null
    },
    u
  );
  return { bitmap: new Uint8Array(m.drawBitmap), result: m.result };
}
function ev(e, t, n) {
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
async function W1(e, t, n, a) {
  const l = e.backgroundVolume, i = e.drawing;
  if (!(l != null && l.imgRAS) || !i) return;
  const { bitmap: o } = await Pg(
    n,
    i.bitmap,
    i.dims,
    l.imgRAS,
    ev(t, l, a),
    i.voxelSizeMM
  );
  i.pushUndo(), i.update(o);
}
function $1(e) {
  const t = v.useRef(null), n = v.useRef(!1), a = v.useRef(null), l = v.useRef(0);
  v.useEffect(() => {
    const i = e.current;
    if (!i) return;
    const o = i.createExtensionContext(), s = () => T.getState().drawingOptions, c = async (C, x) => {
      const S = o.drawing, h = o.backgroundVolume;
      if (!S || !(h != null && h.imgRAS)) return;
      t.current == null && (t.current = S.bitmap.slice());
      const d = l.current, { bitmap: y } = await Pg(
        C,
        t.current,
        // magicWand copies its buffer, so this stays intact
        S.dims,
        h.imgRAS,
        ev(s(), h, x),
        S.voxelSizeMM
      );
      d === l.current && S.update(y);
    }, u = () => {
      if (n.current) return;
      const C = a.current;
      C && (a.current = null, n.current = !0, c(C.seed, C.sliceType).finally(() => {
        n.current = !1, u();
      }));
    }, m = (C) => {
      var x;
      s().mode === "wand" && (!o.drawing || !((x = o.backgroundVolume) != null && x.imgRAS) || (a.current = {
        seed: C.detail.voxel,
        sliceType: C.detail.sliceType
      }, u()));
    }, g = () => {
      var C;
      l.current++, a.current = null, t.current != null && ((C = o.drawing) == null || C.update(t.current), t.current = null);
    }, f = (C) => {
      var x;
      if (s().mode === "wand" && !(!o.drawing || !((x = o.backgroundVolume) != null && x.imgRAS)))
        if (a.current = null, t.current != null) {
          const S = o.drawing, h = S.bitmap.slice();
          S.update(t.current), S.pushUndo(), S.update(h), t.current = null;
        } else n.current || (n.current = !0, W1(
          o,
          s(),
          C.detail.voxel,
          C.detail.sliceType
        ).finally(() => {
          n.current = !1;
        }));
    }, p = (C) => {
      var x;
      ((x = C.detail) == null ? void 0 : x.action) !== "update" && (l.current++, t.current = null);
    };
    return o.on("slicePointerMove", m), o.on("slicePointerUp", f), o.on("slicePointerLeave", g), o.on("drawingChanged", p), () => o.dispose();
  }, [e]);
}
function P1(e, t) {
  const n = e.volumes;
  return Array.isArray(n) && n.forEach((a, l) => {
    if (typeof a != "object" || a === null || Array.isArray(a)) return;
    const i = t[l];
    if (i == null) return;
    const o = a;
    delete o.data, o.url = i;
  }), e;
}
let Va = null, La = null;
function tv() {
  const e = T.getState();
  return e.skipImagingUploadConfirmation ? Promise.resolve(!0) : (Va && (Va(!1), Va = null), new Promise((t) => {
    Va = t, e.setImagingUploadConfirmDialogOpen(!0);
  }));
}
function pd(e) {
  T.getState().setImagingUploadConfirmDialogOpen(!1);
  const t = Va;
  Va = null, t && t(e);
}
function ex() {
  const e = T.getState();
  return e.skipSessionDeleteConfirmation ? Promise.resolve(!0) : (La && (La(!1), La = null), new Promise((t) => {
    La = t, e.setSessionDeleteConfirmDialogOpen(!0);
  }));
}
function yd(e) {
  T.getState().setSessionDeleteConfirmDialogOpen(!1);
  const t = La;
  La = null, t && t(e);
}
const tx = {
  placeholderText: "Drag-drop images",
  isDragDropEnabled: !0,
  backgroundColor: [0, 0, 0, 1],
  crosshairColor: [1, 0, 0, 0.5]
}, dr = {
  neverSave: ["volume.matcap"]
};
function nx(e = {}) {
  return new vy({ ...tx, ...e });
}
function bd(e, t) {
  return e.toLowerCase().endsWith(t) ? e : e + t;
}
function xd(e, t, n) {
  const a = new Blob([e], { type: n }), l = URL.createObjectURL(a), i = document.createElement("a");
  i.href = l, i.download = t, document.body.appendChild(i), i.click(), document.body.removeChild(i), URL.revokeObjectURL(l);
}
function ax(e) {
  const t = T((f) => f.setSaveDialogOpen), n = T((f) => f.saveState), a = T((f) => f.setSaveState), l = v.useCallback(
    async (f = !1) => {
      if (!e.current || !f && e.current.volumes.length > 0 && !await tv())
        return;
      const p = e.current.volumes.map((C) => {
        const x = !!(C.url && C.url.startsWith("http"));
        return {
          enabled: !x,
          isExternal: x,
          url: f ? C.name || "" : C.url || ""
        };
      });
      a({
        isDownloadMode: f,
        document: {
          enabled: !1,
          location: "",
          format: "json"
        },
        volumes: p
      }), t(!0);
    },
    [e, a, t]
  ), i = v.useCallback(async () => {
    if (console.log("Saving scene to:", n.document.location), !!e.current) {
      if (n.isDownloadMode) {
        if (n.document.enabled && n.document.location.trim())
          try {
            const f = bd(n.document.location.trim(), ".nvd"), p = n.document.format, C = e.current.serializeDocument({
              format: p,
              settings: dr
            });
            xd(
              C,
              f,
              p === "json" ? "application/json" : "application/cbor"
            );
          } catch (f) {
            console.error("Error downloading document:", f);
          }
        for (let f = 0; f < n.volumes.length; f++) {
          const p = n.volumes[f];
          if (p.enabled && e.current && e.current.volumes[f]) {
            const C = bd(
              p.url || `volume_${f + 1}.nii.gz`,
              ".nii.gz"
            );
            try {
              const x = await e.current.saveVolume({
                filename: "",
                volumeByIndex: f
              });
              if (!(x instanceof Uint8Array))
                throw new Error("saveVolume did not return bytes");
              const S = await Xo(x);
              xd(S, C, "application/octet-stream");
            } catch (x) {
              console.error(`Error downloading volume ${f}:`, x);
            }
          }
        }
      } else {
        if (n.document.enabled && n.document.location.trim())
          try {
            const p = n.volumes.map(
              (h) => h.url && h.url.trim() ? h.url : null
            ), C = n.document.format;
            let x;
            if (C === "cbor")
              x = qo(
                e.current.serializeDocument({
                  linkData: !0,
                  settings: dr
                })
              );
            else {
              const h = new TextDecoder().decode(
                e.current.serializeDocument({
                  format: "json",
                  linkData: !0,
                  settings: dr
                })
              );
              x = P1(
                JSON.parse(h),
                p
              );
            }
            const S = await fetch(Et("nvd"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                filename: n.document.location,
                data: x,
                format: C
              })
            });
            if (!S.ok)
              throw new Error(`Failed to save document: ${S.statusText}`);
            console.log("Document saved:", await S.json());
          } catch (p) {
            console.error("Error saving document:", p);
          }
        const f = n.volumes.map(
          async (p, C) => {
            if (p.enabled && e.current && e.current.volumes[C]) {
              if (!p.url || p.url.trim() === "") {
                console.log(`Skipping volume ${C}: no URL specified`);
                return;
              }
              try {
                const x = await e.current.saveVolume({
                  filename: "",
                  volumeByIndex: C
                });
                if (!(x instanceof Uint8Array))
                  throw new Error("saveVolume did not return bytes");
                const S = await Xo(x), h = qo(S), d = await fetch(Et("nii"), {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json"
                  },
                  body: JSON.stringify({
                    filename: p.url,
                    data: h
                  })
                });
                if (!d.ok)
                  throw new Error(
                    `Failed to save volume ${C}: ${d.statusText}`
                  );
                const y = await d.json();
                console.log(`Volume ${C} saved successfully:`, y);
              } catch (x) {
                console.error(`Error saving volume ${C}:`, x);
              }
            }
          }
        );
        await Promise.all(f);
      }
      t(!1), a({
        isDownloadMode: !1,
        document: {
          enabled: !1,
          location: "",
          format: "json"
        },
        volumes: []
      });
    }
  }, [e, n, t, a]), o = v.useCallback(() => {
    t(!1), a({
      isDownloadMode: !1,
      document: {
        enabled: !1,
        location: "",
        format: "json"
      },
      volumes: []
    });
  }, [t, a]), s = v.useCallback(
    (f, p) => {
      a((C) => ({
        ...C,
        volumes: C.volumes.map(
          (x, S) => S === f ? { ...x, url: p } : x
        )
      }));
    },
    [a]
  ), c = v.useCallback(
    (f, p) => {
      a((C) => ({
        ...C,
        volumes: C.volumes.map((x, S) => S === f ? p && x.isExternal ? { ...x, enabled: p, url: "" } : { ...x, enabled: p } : x)
      }));
    },
    [a]
  ), u = v.useCallback(
    (f) => {
      a((p) => ({
        ...p,
        document: {
          ...p.document,
          location: f
        }
      }));
    },
    [a]
  ), m = v.useCallback(
    (f) => {
      a((p) => ({
        ...p,
        document: {
          ...p.document,
          enabled: f
        }
      }));
    },
    [a]
  ), g = v.useCallback(
    (f) => {
      a((p) => ({
        ...p,
        document: {
          ...p.document,
          format: f
        }
      }));
    },
    [a]
  );
  return {
    handleSaveScene: l,
    handleConfirmSave: i,
    handleCancelSave: o,
    handleVolumeUrlChange: s,
    handleVolumeCheckboxChange: c,
    handleDocumentLocationChange: u,
    handleDocumentCheckboxChange: m,
    handleDocumentFormatChange: g
  };
}
const Sd = "This .nvd predates the niivue document schema (it has `imageOptionsArray` and no `version`). Regenerate it with scripts/migrate-nvd.py.";
function Cd(e) {
  if (e instanceof Uint8Array) {
    if (e.find(
      (l) => l !== 32 && l !== 9 && l !== 10 && l !== 13
    ) !== 123) return;
    const n = new TextDecoder("utf-8", { fatal: !1 }).decode(
      e.subarray(0, 64 * 1024)
    );
    if ((n.includes('"imageOptionsArray"') || n.includes('"encodedImageBlobs"')) && !n.includes('"version"'))
      throw new Error(Sd);
    return;
  }
  if (("imageOptionsArray" in e || "encodedImageBlobs" in e) && typeof e.version != "number")
    throw new Error(Sd);
}
function lx(e, t, n, a) {
  const l = T((w) => w.showUploader), i = T((w) => w.setShowUploader), o = T((w) => w.currentImageIndex), s = T(
    (w) => w.setCurrentImageIndex
  ), c = T((w) => w.volumeVersion), u = T(
    (w) => w.incrementVolumeVersion
  ), m = T((w) => w.currentSurfaceIndex), g = T(
    (w) => w.setCurrentSurfaceIndex
  ), f = T((w) => w.setActiveTab), p = Qo.serverless, C = v.useRef(null), x = v.useRef(null), S = v.useCallback(
    async (w) => {
      const E = e.current;
      if (!E) return;
      let R;
      if (w instanceof ArrayBuffer || w instanceof Uint8Array) {
        const k = w instanceof Uint8Array ? w : new Uint8Array(w);
        Cd(k), R = new File([k], "scene.nvd", {
          type: "application/octet-stream"
        });
      } else
        Cd(w), R = new File([JSON.stringify(w)], "scene.nvd", {
          type: "application/json"
        });
      await E.loadDocument(R, { fill: "current" }), await q1(E), o === null && E.volumes.length > 0 && s(0), m === null && E.meshes.length > 0 && g(0);
    },
    [
      e,
      n,
      a,
      o,
      m,
      s,
      g
    ]
  ), h = v.useCallback(
    async (w) => {
      if (!e.current) return;
      const E = e.current;
      l && i(!1);
      let R = 0;
      for (; !E.canvas && R < 20; )
        console.log(
          `Waiting for canvas to be ready for file upload... attempt ${R + 1}`
        ), await new Promise((V) => setTimeout(V, 100)), R++;
      if (!E.canvas)
        throw new Error("Canvas failed to initialize after 2 seconds");
      const k = w.filter(
        (V) => V.name.toLowerCase().endsWith(".nvd") || V.name.toLowerCase().endsWith(".json")
      );
      if (k.length > 0) {
        const V = k[0];
        try {
          const J = await V.arrayBuffer();
          console.log("NVD file loaded:", V.name, J.byteLength, "bytes"), await S(J);
        } catch (J) {
          console.error("Error loading uploaded NVD file:", J);
        }
      } else {
        const V = w.map(async (J) => {
          await E.addVolume({ url: J, name: J.name });
        });
        await Promise.all(V), t(), u(), o === null && w.length > 0 && s(0);
      }
    },
    [
      e,
      l,
      o,
      S,
      t,
      u,
      i,
      s
    ]
  ), d = v.useCallback(
    async (w) => {
      if (!e.current) return;
      const E = e.current;
      try {
        l && i(!1);
        let R = 0;
        for (; !E.canvas && R < 20; )
          console.log(
            `Waiting for canvas to be ready for imaging file... attempt ${R + 1}`
          ), await new Promise((J) => setTimeout(J, 100)), R++;
        if (!E.canvas)
          throw new Error("Canvas failed to initialize after 2 seconds");
        const k = w.filename.split("/").pop() || w.filename, V = {
          url: w.url,
          name: k
        };
        console.log("Adding imaging file to scene:", V), await E.addVolume(V), t(), u(), E.volumes.length > 0 && s(E.volumes.length - 1), console.log("Imaging file loaded successfully");
      } catch (R) {
        console.error("Error loading imaging file:", R);
      }
    },
    [
      e,
      l,
      t,
      u,
      i,
      s
    ]
  ), y = v.useCallback(
    async (w) => {
      if (!e.current) return;
      const E = e.current;
      try {
        const R = await fetch(w.url);
        if (!R.ok)
          throw new Error(`HTTP error! status: ${R.status}`);
        const k = await R.arrayBuffer();
        console.log(`NVD fetched from ${w.url}: ${k.byteLength} bytes`), i(!1);
        let V = 0;
        for (; !E.canvas && V < 20; )
          console.log(
            `Waiting for canvas to be ready... attempt ${V + 1}`
          ), await new Promise((J) => setTimeout(J, 100)), V++;
        if (!E.canvas)
          throw new Error("Canvas failed to initialize after 2 seconds");
        await S(k);
      } catch (R) {
        console.error("Error loading NVD:", R);
      }
    },
    [e, S, i]
  ), b = v.useCallback(
    (w) => {
      if (w.target.files && w.target.files.length > 0) {
        const E = Array.from(w.target.files);
        h(E);
      }
      w.target.value = "";
    },
    [h]
  ), N = v.useCallback(() => {
    var w;
    (w = C.current) == null || w.click();
  }, []), O = v.useCallback(() => {
    var w;
    (w = x.current) == null || w.click();
  }, []), M = v.useCallback(
    async (w) => {
      if (w.target.files && w.target.files.length > 0 && e.current) {
        const E = e.current, R = Array.from(w.target.files);
        l && i(!1);
        let k = 0;
        for (; !E.canvas && k < 20; )
          await new Promise((V) => setTimeout(V, 100)), k++;
        if (!E.canvas) {
          console.error("Canvas failed to initialize for surface upload");
          return;
        }
        try {
          for (const V of R)
            await E.addMesh({
              url: V,
              name: V.name,
              color: [1, 1, 0, 1],
              shaderType: "phong"
            });
        } catch (V) {
          console.error("Error loading surface files:", V);
        }
        m === null && E.meshes.length > 0 && g(E.meshes.length - R.length);
      }
      w.target.value = "";
    },
    [
      e,
      l,
      m,
      i,
      g
    ]
  );
  v.useEffect(() => {
    const w = e.current;
    if (!w) return;
    const E = () => {
      requestAnimationFrame(() => u());
    };
    return w.addEventListener("dragRelease", E), () => {
      w.removeEventListener("dragRelease", E);
    };
  }, [e, u]);
  const A = T((w) => w.dragDropEnabled);
  return v.useEffect(() => {
    var w;
    e.current && (e.current.isDragDropEnabled = A && l && (((w = e.current.volumes) == null ? void 0 : w.length) ?? 0) === 0);
  }, [e, c, l, A]), v.useEffect(() => {
    p && f("sceneDetails");
  }, [p, f]), v.useEffect(() => {
    if (!Za().readUrlParams) return;
    const E = new URLSearchParams(window.location.search).get("nvd");
    if (E) {
      console.log("Loading NVD from URL parameter:", E);
      const R = {
        filename: E.split("/").pop() || E,
        url: E
      };
      y(R);
    }
  }, []), v.useEffect(() => {
    if (!Za().readUrlParams) return;
    const E = new URLSearchParams(window.location.search).get("vol");
    if (E) {
      console.log("Loading volume from URL parameter:", E);
      const k = { filename: E.split("/").pop() || E, url: E };
      d(k);
    }
  }, []), v.useEffect(() => {
    const w = async (E) => {
      if (!E.detail || !e.current || window.__EMBEDDED_NVD_LOADED__) return;
      window.__EMBEDDED_NVD_LOADED__ = !0, console.log("Loading embedded NVD data"), i(!1);
      let R = 0;
      for (; !e.current.canvas && R < 20; )
        await new Promise((k) => setTimeout(k, 100)), R++;
      e.current.canvas && await S(E.detail);
    };
    return window.addEventListener(
      "loadEmbeddedNvd",
      w
    ), window.__EMBEDDED_NVD_DATA__ && !window.__EMBEDDED_NVD_LOADED__ && window.dispatchEvent(
      new CustomEvent("loadEmbeddedNvd", {
        detail: window.__EMBEDDED_NVD_DATA__
      })
    ), () => window.removeEventListener(
      "loadEmbeddedNvd",
      w
    );
  }, []), {
    serverlessMode: p,
    fileInputRef: C,
    surfaceFileInputRef: x,
    loadNvdData: S,
    handleFileUpload: h,
    handleImagingFileSelect: d,
    handleNvdFileSelect: y,
    handleFileChange: b,
    handleAddMoreFiles: N,
    handleAddSurfaceFiles: O,
    handleSurfaceFileChange: M
  };
}
function ix() {
  const e = T((t) => t.setAiEnabled);
  v.useEffect(() => {
    if (Qo.serverless) {
      e(!1);
      return;
    }
    let t = !1;
    return (async () => {
      try {
        const n = await fetch(Nn("model/list"));
        if (!n.ok) {
          t || e(!1);
          return;
        }
        const a = await n.json();
        if (t) return;
        e(Array.isArray(a) && a.length > 0);
      } catch {
        t || e(!1);
      }
    })(), () => {
      t = !0;
    };
  }, [e]);
}
const ox = /^[A-Za-z0-9_-]+$/;
async function sx() {
  const e = await fetch(Nn("session/list"));
  if (!e.ok) throw new Error(`GET /ai/session/list failed: ${e.status}`);
  return e.json();
}
function rx(e) {
  return e ? e.endsWith(".nii.gz") || e.endsWith(".nii") ? e : `${e}.nii.gz` : "volume.nii.gz";
}
function cx(e) {
  return M1(e);
}
async function ux(e) {
  const t = await fetch(e);
  if (!t.ok) throw new Error(`GET ${e} failed: ${t.status}`);
  return new Uint8Array(await t.arrayBuffer());
}
async function wd(e, t) {
  if (!e.drawingVolume || e.volumes.length === 0) return null;
  const n = await e.saveVolume({
    filename: "",
    isSaveDrawing: !0,
    volumeByIndex: 0
  });
  if (!(n instanceof Uint8Array)) return null;
  const a = await Xo(n), l = "annotations.nii.gz", i = `ai-sessions/${t}/${l}`, o = await fetch(Et("nii"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: i,
      data: qo(a)
    })
  });
  if (!o.ok)
    throw new Error(
      `annotations upload failed: ${o.status} ${o.statusText}`
    );
  return l;
}
async function Ad(e, t) {
  const n = await fetch(
    Nn(`session/${encodeURIComponent(e)}/set_annots`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotation_path: t })
    }
  );
  if (!n.ok) {
    const a = await n.text();
    throw new Error(`set_annots failed (${n.status}): ${a}`);
  }
}
const Qi = "result.nii.gz", Nd = "sky_blue", fx = {
  R: [0, 91, 91],
  G: [0, 163, 163],
  B: [0, 201, 201],
  A: [0, 64, 128],
  I: [0, 128, 255]
}, dx = {
  R: [0, 0, 255],
  G: [0, 255, 0],
  B: [0, 0, 0],
  A: [0, 255, 255],
  I: [0, 1, 2],
  labels: ["background", "positive", "negative"]
};
function mx(e) {
  const t = T((d) => d.aiEnabled), n = T((d) => d.setAiSessions), a = T((d) => d.setAiActiveSession), l = T((d) => d.aiActiveSession), i = T((d) => d.drawingOptions), o = T((d) => d.setDrawingOptions), s = T((d) => d.setActiveTab), c = T((d) => d.setShowUploader), u = T(
    (d) => d.incrementVolumeVersion
  ), m = v.useCallback(async () => {
    try {
      const d = await sx();
      n(d);
    } catch (d) {
      console.error("Failed to refresh AI sessions:", d);
    }
  }, [n]);
  v.useEffect(() => {
    t && m();
  }, [t, m]);
  const g = v.useCallback(() => {
    const d = e.current;
    if (!d) return;
    const y = i.penValue === 2 ? 2 : 1;
    d.drawingVolume || d.createEmptyDrawing(), d.addColormap("ai_prompt", dx), d.drawColormap = "ai_prompt", d.drawPenValue = y, d.drawOpacity = 1, d.drawIsEnabled = !1, o((b) => ({
      ...b,
      enabled: !0,
      mode: "none",
      opacity: 1,
      penValue: y
    })), s("aiAnnotation");
  }, [
    e,
    i.penValue,
    o,
    s
  ]), f = v.useCallback(() => {
    const d = e.current;
    d && (d.drawIsEnabled = !1, d.closeDrawing()), o((y) => ({ ...y, enabled: !1, mode: "none" })), a(null), u();
  }, [e, o, a, u]), p = v.useCallback(
    async (d) => {
      const y = d.trim();
      if (!y) throw new Error("Session name is required");
      if (!ox.test(y))
        throw new Error(
          "Session name may only contain letters, digits, underscores, and hyphens"
        );
      const b = e.current;
      if (!b || b.volumes.length === 0)
        throw new Error("Load a volume before creating a session");
      const N = b.volumes[0], O = typeof N.url == "string" ? cx(N.url) : null, M = !O;
      if (M && !await tv())
        throw new Error("Upload cancelled");
      const A = await fetch(Nn("session/new"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_name: y })
      });
      if (!A.ok) {
        const V = await A.text();
        throw new Error(`Create session failed (${A.status}): ${V}`);
      }
      const { session_id: w, session_name: E } = await A.json();
      let R;
      if (M) {
        const V = rx(N.name), J = `ai-sessions/${y}/${V}`, z = await b.saveVolume({ filename: "", volumeByIndex: 0 }), j = z instanceof Uint8Array ? await Xo(z) : new Uint8Array(), U = qo(j), D = await fetch(Et("nii"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: J, data: U })
        });
        if (!D.ok)
          throw new Error(
            `Volume upload failed: ${D.status} ${D.statusText}`
          );
        R = J;
      } else
        R = O;
      const k = await fetch(
        Nn(`session/${encodeURIComponent(w)}/set_volume`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volume_path: R })
        }
      );
      if (!k.ok) {
        const V = await k.text();
        throw new Error(`set_volume failed (${k.status}): ${V}`);
      }
      a({ session_id: w, session_name: E }), g(), await m();
    },
    [e, a, g, m]
  ), C = v.useCallback(
    async (d) => {
      const y = e.current;
      if (!y) throw new Error("Viewer not ready");
      const b = T.getState().aiSessions.find((O) => O.session_id === d);
      if (!b) throw new Error(`Unknown session: ${d}`);
      if (!b.volume_path)
        throw new Error("Session has no volume set; cannot load");
      const N = b.volume_path_root === "session" ? Et(`ai-sessions/${b.session_name}/${b.volume_path}`) : Et(b.volume_path);
      if (c(!1), await y.loadVolumes([{ url: N }]), u(), b.annotation_path)
        try {
          const O = Et(
            `ai-sessions/${b.session_name}/${b.annotation_path}`
          ), M = await ux(O), A = new File([M], b.annotation_path);
          await y.loadDrawing(A) || console.warn(
            "loadDrawing returned false — annotation dimensions may not match the volume"
          );
        } catch (O) {
          console.error("Failed to load existing annotations:", O);
        }
      a({
        session_id: b.session_id,
        session_name: b.session_name
      }), g();
    },
    [
      e,
      c,
      u,
      a,
      g
    ]
  ), x = v.useCallback(
    async (d, y) => {
      const b = e.current, N = T.getState().aiActiveSession;
      if (!b || !N || b.volumes.length === 0)
        throw new Error("No active session or volume");
      const O = await wd(b, N.session_name);
      if (!O) throw new Error("No drawing layer to send as annotations");
      await Ad(N.session_id, O);
      const M = await fetch(
        Nn(
          `session/${encodeURIComponent(N.session_id)}/infer/${encodeURIComponent(d)}`
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label_value: y })
        }
      );
      if (!M.ok) {
        const E = await M.text();
        throw new Error(`inference failed (${M.status}): ${E}`);
      }
      await M.json();
      const A = b.volumes.length - 1;
      if (A > 0) {
        const E = b.volumes[A], R = typeof (E == null ? void 0 : E.name) == "string" ? E.name : "", k = typeof (E == null ? void 0 : E.url) == "string" ? E.url : "";
        (R === Qi || k.includes(`/${Qi}`)) && await b.removeVolume(A);
      }
      const w = Et(`ai-sessions/${N.session_name}/${Qi}`) + `?t=${Date.now()}`;
      b.addColormap(Nd, fx), await b.addVolume({
        url: w,
        name: Qi,
        colormap: Nd,
        opacity: 0.5
      }), u();
    },
    [e, u]
  ), S = v.useCallback(async () => {
    const d = e.current, y = T.getState().aiActiveSession;
    if (d && y)
      try {
        const b = await wd(d, y.session_name);
        b && await Ad(y.session_id, b);
      } catch (b) {
        console.error("Failed to save annotations on exit:", b);
      }
    f();
  }, [e, f]), h = v.useCallback(async () => {
    if (!l || !await ex()) return;
    const y = l.session_id;
    try {
      const b = await fetch(Nn(`session/${encodeURIComponent(y)}`), {
        method: "DELETE"
      });
      if (!b.ok) {
        const N = await b.text();
        console.error(`DELETE session failed (${b.status}): ${N}`);
      }
    } catch (b) {
      console.error("DELETE session error:", b);
    }
    f(), await m();
  }, [l, f, m]);
  return {
    refreshSessions: m,
    handleNewSession: p,
    handleLoadSession: C,
    handleRunSegmentation: x,
    handleExitAndSaveSession: S,
    handleExitAndDeleteSession: h
  };
}
function nv(e) {
  var t, n, a = "";
  if (typeof e == "string" || typeof e == "number") a += e;
  else if (typeof e == "object") if (Array.isArray(e)) {
    var l = e.length;
    for (t = 0; t < l; t++) e[t] && (n = nv(e[t])) && (a && (a += " "), a += n);
  } else for (n in e) e[n] && (a && (a += " "), a += n);
  return a;
}
function av() {
  for (var e, t, n = 0, a = "", l = arguments.length; n < l; n++) (e = arguments[n]) && (t = nv(e)) && (a && (a += " "), a += t);
  return a;
}
const hx = (e, t) => {
  const n = new Array(e.length + t.length);
  for (let a = 0; a < e.length; a++)
    n[a] = e[a];
  for (let a = 0; a < t.length; a++)
    n[e.length + a] = t[a];
  return n;
}, gx = (e, t) => ({
  classGroupId: e,
  validator: t
}), lv = (e = /* @__PURE__ */ new Map(), t = null, n) => ({
  nextPart: e,
  validators: t,
  classGroupId: n
}), Zo = "-", Ed = [], vx = "arbitrary..", px = (e) => {
  const t = bx(e), {
    conflictingClassGroups: n,
    conflictingClassGroupModifiers: a
  } = e;
  return {
    getClassGroupId: (o) => {
      if (o.startsWith("[") && o.endsWith("]"))
        return yx(o);
      const s = o.split(Zo), c = s[0] === "" && s.length > 1 ? 1 : 0;
      return iv(s, c, t);
    },
    getConflictingClassGroupIds: (o, s) => {
      if (s) {
        const c = a[o], u = n[o];
        return c ? u ? hx(u, c) : c : u || Ed;
      }
      return n[o] || Ed;
    }
  };
}, iv = (e, t, n) => {
  if (e.length - t === 0)
    return n.classGroupId;
  const l = e[t], i = n.nextPart.get(l);
  if (i) {
    const u = iv(e, t + 1, i);
    if (u) return u;
  }
  const o = n.validators;
  if (o === null)
    return;
  const s = t === 0 ? e.join(Zo) : e.slice(t).join(Zo), c = o.length;
  for (let u = 0; u < c; u++) {
    const m = o[u];
    if (m.validator(s))
      return m.classGroupId;
  }
}, yx = (e) => e.slice(1, -1).indexOf(":") === -1 ? void 0 : (() => {
  const t = e.slice(1, -1), n = t.indexOf(":"), a = t.slice(0, n);
  return a ? vx + a : void 0;
})(), bx = (e) => {
  const {
    theme: t,
    classGroups: n
  } = e;
  return xx(n, t);
}, xx = (e, t) => {
  const n = lv();
  for (const a in e) {
    const l = e[a];
    Su(l, n, a, t);
  }
  return n;
}, Su = (e, t, n, a) => {
  const l = e.length;
  for (let i = 0; i < l; i++) {
    const o = e[i];
    Sx(o, t, n, a);
  }
}, Sx = (e, t, n, a) => {
  if (typeof e == "string") {
    Cx(e, t, n);
    return;
  }
  if (typeof e == "function") {
    wx(e, t, n, a);
    return;
  }
  Ax(e, t, n, a);
}, Cx = (e, t, n) => {
  const a = e === "" ? t : ov(t, e);
  a.classGroupId = n;
}, wx = (e, t, n, a) => {
  if (Nx(e)) {
    Su(e(a), t, n, a);
    return;
  }
  t.validators === null && (t.validators = []), t.validators.push(gx(n, e));
}, Ax = (e, t, n, a) => {
  const l = Object.entries(e), i = l.length;
  for (let o = 0; o < i; o++) {
    const [s, c] = l[o];
    Su(c, ov(t, s), n, a);
  }
}, ov = (e, t) => {
  let n = e;
  const a = t.split(Zo), l = a.length;
  for (let i = 0; i < l; i++) {
    const o = a[i];
    let s = n.nextPart.get(o);
    s || (s = lv(), n.nextPart.set(o, s)), n = s;
  }
  return n;
}, Nx = (e) => "isThemeGetter" in e && e.isThemeGetter === !0, Ex = (e) => {
  if (e < 1)
    return {
      get: () => {
      },
      set: () => {
      }
    };
  let t = 0, n = /* @__PURE__ */ Object.create(null), a = /* @__PURE__ */ Object.create(null);
  const l = (i, o) => {
    n[i] = o, t++, t > e && (t = 0, a = n, n = /* @__PURE__ */ Object.create(null));
  };
  return {
    get(i) {
      let o = n[i];
      if (o !== void 0)
        return o;
      if ((o = a[i]) !== void 0)
        return l(i, o), o;
    },
    set(i, o) {
      i in n ? n[i] = o : l(i, o);
    }
  };
}, mc = "!", jd = ":", jx = [], Md = (e, t, n, a, l) => ({
  modifiers: e,
  hasImportantModifier: t,
  baseClassName: n,
  maybePostfixModifierPosition: a,
  isExternal: l
}), Mx = (e) => {
  const {
    prefix: t,
    experimentalParseClassName: n
  } = e;
  let a = (l) => {
    const i = [];
    let o = 0, s = 0, c = 0, u;
    const m = l.length;
    for (let x = 0; x < m; x++) {
      const S = l[x];
      if (o === 0 && s === 0) {
        if (S === jd) {
          i.push(l.slice(c, x)), c = x + 1;
          continue;
        }
        if (S === "/") {
          u = x;
          continue;
        }
      }
      S === "[" ? o++ : S === "]" ? o-- : S === "(" ? s++ : S === ")" && s--;
    }
    const g = i.length === 0 ? l : l.slice(c);
    let f = g, p = !1;
    g.endsWith(mc) ? (f = g.slice(0, -1), p = !0) : (
      /**
       * In Tailwind CSS v3 the important modifier was at the start of the base class name. This is still supported for legacy reasons.
       * @see https://github.com/dcastil/tailwind-merge/issues/513#issuecomment-2614029864
       */
      g.startsWith(mc) && (f = g.slice(1), p = !0)
    );
    const C = u && u > c ? u - c : void 0;
    return Md(i, p, f, C);
  };
  if (t) {
    const l = t + jd, i = a;
    a = (o) => o.startsWith(l) ? i(o.slice(l.length)) : Md(jx, !1, o, void 0, !0);
  }
  if (n) {
    const l = a;
    a = (i) => n({
      className: i,
      parseClassName: l
    });
  }
  return a;
}, Tx = (e) => {
  const t = /* @__PURE__ */ new Map();
  return e.orderSensitiveModifiers.forEach((n, a) => {
    t.set(n, 1e6 + a);
  }), (n) => {
    const a = [];
    let l = [];
    for (let i = 0; i < n.length; i++) {
      const o = n[i], s = o[0] === "[", c = t.has(o);
      s || c ? (l.length > 0 && (l.sort(), a.push(...l), l = []), a.push(o)) : l.push(o);
    }
    return l.length > 0 && (l.sort(), a.push(...l)), a;
  };
}, Dx = (e) => ({
  cache: Ex(e.cacheSize),
  parseClassName: Mx(e),
  sortModifiers: Tx(e),
  ...px(e)
}), _x = /\s+/, Ox = (e, t) => {
  const {
    parseClassName: n,
    getClassGroupId: a,
    getConflictingClassGroupIds: l,
    sortModifiers: i
  } = t, o = [], s = e.trim().split(_x);
  let c = "";
  for (let u = s.length - 1; u >= 0; u -= 1) {
    const m = s[u], {
      isExternal: g,
      modifiers: f,
      hasImportantModifier: p,
      baseClassName: C,
      maybePostfixModifierPosition: x
    } = n(m);
    if (g) {
      c = m + (c.length > 0 ? " " + c : c);
      continue;
    }
    let S = !!x, h = a(S ? C.substring(0, x) : C);
    if (!h) {
      if (!S) {
        c = m + (c.length > 0 ? " " + c : c);
        continue;
      }
      if (h = a(C), !h) {
        c = m + (c.length > 0 ? " " + c : c);
        continue;
      }
      S = !1;
    }
    const d = f.length === 0 ? "" : f.length === 1 ? f[0] : i(f).join(":"), y = p ? d + mc : d, b = y + h;
    if (o.indexOf(b) > -1)
      continue;
    o.push(b);
    const N = l(h, S);
    for (let O = 0; O < N.length; ++O) {
      const M = N[O];
      o.push(y + M);
    }
    c = m + (c.length > 0 ? " " + c : c);
  }
  return c;
}, zx = (...e) => {
  let t = 0, n, a, l = "";
  for (; t < e.length; )
    (n = e[t++]) && (a = sv(n)) && (l && (l += " "), l += a);
  return l;
}, sv = (e) => {
  if (typeof e == "string")
    return e;
  let t, n = "";
  for (let a = 0; a < e.length; a++)
    e[a] && (t = sv(e[a])) && (n && (n += " "), n += t);
  return n;
}, Rx = (e, ...t) => {
  let n, a, l, i;
  const o = (c) => {
    const u = t.reduce((m, g) => g(m), e());
    return n = Dx(u), a = n.cache.get, l = n.cache.set, i = s, s(c);
  }, s = (c) => {
    const u = a(c);
    if (u)
      return u;
    const m = Ox(c, n);
    return l(c, m), m;
  };
  return i = o, (...c) => i(zx(...c));
}, kx = [], Oe = (e) => {
  const t = (n) => n[e] || kx;
  return t.isThemeGetter = !0, t;
}, rv = /^\[(?:(\w[\w-]*):)?(.+)\]$/i, cv = /^\((?:(\w[\w-]*):)?(.+)\)$/i, Ux = /^\d+\/\d+$/, Vx = /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/, Lx = /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^0$/, Bx = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix)\(.+\)$/, Hx = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/, Gx = /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/, ba = (e) => Ux.test(e), Z = (e) => !!e && !Number.isNaN(Number(e)), dn = (e) => !!e && Number.isInteger(Number(e)), mr = (e) => e.endsWith("%") && Z(e.slice(0, -1)), Bt = (e) => Vx.test(e), Yx = () => !0, qx = (e) => (
  // `colorFunctionRegex` check is necessary because color functions can have percentages in them which which would be incorrectly classified as lengths.
  // For example, `hsl(0 0% 0%)` would be classified as a length without this check.
  // I could also use lookbehind assertion in `lengthUnitRegex` but that isn't supported widely enough.
  Lx.test(e) && !Bx.test(e)
), uv = () => !1, Xx = (e) => Hx.test(e), Qx = (e) => Gx.test(e), Zx = (e) => !L(e) && !B(e), Fx = (e) => hl(e, mv, uv), L = (e) => rv.test(e), Fn = (e) => hl(e, hv, qx), hr = (e) => hl(e, $x, Z), Td = (e) => hl(e, fv, uv), Kx = (e) => hl(e, dv, Qx), Zi = (e) => hl(e, gv, Xx), B = (e) => cv.test(e), _l = (e) => gl(e, hv), Jx = (e) => gl(e, Px), Dd = (e) => gl(e, fv), Ix = (e) => gl(e, mv), Wx = (e) => gl(e, dv), Fi = (e) => gl(e, gv, !0), hl = (e, t, n) => {
  const a = rv.exec(e);
  return a ? a[1] ? t(a[1]) : n(a[2]) : !1;
}, gl = (e, t, n = !1) => {
  const a = cv.exec(e);
  return a ? a[1] ? t(a[1]) : n : !1;
}, fv = (e) => e === "position" || e === "percentage", dv = (e) => e === "image" || e === "url", mv = (e) => e === "length" || e === "size" || e === "bg-size", hv = (e) => e === "length", $x = (e) => e === "number", Px = (e) => e === "family-name", gv = (e) => e === "shadow", eS = () => {
  const e = Oe("color"), t = Oe("font"), n = Oe("text"), a = Oe("font-weight"), l = Oe("tracking"), i = Oe("leading"), o = Oe("breakpoint"), s = Oe("container"), c = Oe("spacing"), u = Oe("radius"), m = Oe("shadow"), g = Oe("inset-shadow"), f = Oe("text-shadow"), p = Oe("drop-shadow"), C = Oe("blur"), x = Oe("perspective"), S = Oe("aspect"), h = Oe("ease"), d = Oe("animate"), y = () => ["auto", "avoid", "all", "avoid-page", "page", "left", "right", "column"], b = () => [
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
  ], N = () => [...b(), B, L], O = () => ["auto", "hidden", "clip", "visible", "scroll"], M = () => ["auto", "contain", "none"], A = () => [B, L, c], w = () => [ba, "full", "auto", ...A()], E = () => [dn, "none", "subgrid", B, L], R = () => ["auto", {
    span: ["full", dn, B, L]
  }, dn, B, L], k = () => [dn, "auto", B, L], V = () => ["auto", "min", "max", "fr", B, L], J = () => ["start", "end", "center", "between", "around", "evenly", "stretch", "baseline", "center-safe", "end-safe"], z = () => ["start", "end", "center", "stretch", "center-safe", "end-safe"], j = () => ["auto", ...A()], U = () => [ba, "auto", "full", "dvw", "dvh", "lvw", "lvh", "svw", "svh", "min", "max", "fit", ...A()], D = () => [e, B, L], Q = () => [...b(), Dd, Td, {
    position: [B, L]
  }], I = () => ["no-repeat", {
    repeat: ["", "x", "y", "space", "round"]
  }], Be = () => ["auto", "cover", "contain", Ix, Fx, {
    size: [B, L]
  }], we = () => [mr, _l, Fn], ie = () => [
    // Deprecated since Tailwind CSS v4.0.0
    "",
    "none",
    "full",
    u,
    B,
    L
  ], ne = () => ["", Z, _l, Fn], Qe = () => ["solid", "dashed", "dotted", "double"], ln = () => ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"], ye = () => [Z, mr, Dd, Td], ga = () => [
    // Deprecated since Tailwind CSS v4.0.0
    "",
    "none",
    C,
    B,
    L
  ], on = () => ["none", Z, B, L], sn = () => ["none", Z, B, L], rn = () => [Z, B, L], cn = () => [ba, "full", ...A()];
  return {
    cacheSize: 500,
    theme: {
      animate: ["spin", "ping", "pulse", "bounce"],
      aspect: ["video"],
      blur: [Bt],
      breakpoint: [Bt],
      color: [Yx],
      container: [Bt],
      "drop-shadow": [Bt],
      ease: ["in", "out", "in-out"],
      font: [Zx],
      "font-weight": ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"],
      "inset-shadow": [Bt],
      leading: ["none", "tight", "snug", "normal", "relaxed", "loose"],
      perspective: ["dramatic", "near", "normal", "midrange", "distant", "none"],
      radius: [Bt],
      shadow: [Bt],
      spacing: ["px", Z],
      text: [Bt],
      "text-shadow": [Bt],
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
        aspect: ["auto", "square", ba, L, B, S]
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
        columns: [Z, L, B, s]
      }],
      /**
       * Break After
       * @see https://tailwindcss.com/docs/break-after
       */
      "break-after": [{
        "break-after": y()
      }],
      /**
       * Break Before
       * @see https://tailwindcss.com/docs/break-before
       */
      "break-before": [{
        "break-before": y()
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
        object: N()
      }],
      /**
       * Overflow
       * @see https://tailwindcss.com/docs/overflow
       */
      overflow: [{
        overflow: O()
      }],
      /**
       * Overflow X
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-x": [{
        "overflow-x": O()
      }],
      /**
       * Overflow Y
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-y": [{
        "overflow-y": O()
      }],
      /**
       * Overscroll Behavior
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      overscroll: [{
        overscroll: M()
      }],
      /**
       * Overscroll Behavior X
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-x": [{
        "overscroll-x": M()
      }],
      /**
       * Overscroll Behavior Y
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-y": [{
        "overscroll-y": M()
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
        inset: w()
      }],
      /**
       * Right / Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-x": [{
        "inset-x": w()
      }],
      /**
       * Top / Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-y": [{
        "inset-y": w()
      }],
      /**
       * Start
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      start: [{
        start: w()
      }],
      /**
       * End
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      end: [{
        end: w()
      }],
      /**
       * Top
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      top: [{
        top: w()
      }],
      /**
       * Right
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      right: [{
        right: w()
      }],
      /**
       * Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      bottom: [{
        bottom: w()
      }],
      /**
       * Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      left: [{
        left: w()
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
        z: [dn, "auto", B, L]
      }],
      // ------------------------
      // --- Flexbox and Grid ---
      // ------------------------
      /**
       * Flex Basis
       * @see https://tailwindcss.com/docs/flex-basis
       */
      basis: [{
        basis: [ba, "full", "auto", s, ...A()]
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
        flex: [Z, ba, "auto", "initial", "none", L]
      }],
      /**
       * Flex Grow
       * @see https://tailwindcss.com/docs/flex-grow
       */
      grow: [{
        grow: ["", Z, B, L]
      }],
      /**
       * Flex Shrink
       * @see https://tailwindcss.com/docs/flex-shrink
       */
      shrink: [{
        shrink: ["", Z, B, L]
      }],
      /**
       * Order
       * @see https://tailwindcss.com/docs/order
       */
      order: [{
        order: [dn, "first", "last", "none", B, L]
      }],
      /**
       * Grid Template Columns
       * @see https://tailwindcss.com/docs/grid-template-columns
       */
      "grid-cols": [{
        "grid-cols": E()
      }],
      /**
       * Grid Column Start / End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start-end": [{
        col: R()
      }],
      /**
       * Grid Column Start
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start": [{
        "col-start": k()
      }],
      /**
       * Grid Column End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-end": [{
        "col-end": k()
      }],
      /**
       * Grid Template Rows
       * @see https://tailwindcss.com/docs/grid-template-rows
       */
      "grid-rows": [{
        "grid-rows": E()
      }],
      /**
       * Grid Row Start / End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start-end": [{
        row: R()
      }],
      /**
       * Grid Row Start
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start": [{
        "row-start": k()
      }],
      /**
       * Grid Row End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-end": [{
        "row-end": k()
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
        "auto-cols": V()
      }],
      /**
       * Grid Auto Rows
       * @see https://tailwindcss.com/docs/grid-auto-rows
       */
      "auto-rows": [{
        "auto-rows": V()
      }],
      /**
       * Gap
       * @see https://tailwindcss.com/docs/gap
       */
      gap: [{
        gap: A()
      }],
      /**
       * Gap X
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-x": [{
        "gap-x": A()
      }],
      /**
       * Gap Y
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-y": [{
        "gap-y": A()
      }],
      /**
       * Justify Content
       * @see https://tailwindcss.com/docs/justify-content
       */
      "justify-content": [{
        justify: [...J(), "normal"]
      }],
      /**
       * Justify Items
       * @see https://tailwindcss.com/docs/justify-items
       */
      "justify-items": [{
        "justify-items": [...z(), "normal"]
      }],
      /**
       * Justify Self
       * @see https://tailwindcss.com/docs/justify-self
       */
      "justify-self": [{
        "justify-self": ["auto", ...z()]
      }],
      /**
       * Align Content
       * @see https://tailwindcss.com/docs/align-content
       */
      "align-content": [{
        content: ["normal", ...J()]
      }],
      /**
       * Align Items
       * @see https://tailwindcss.com/docs/align-items
       */
      "align-items": [{
        items: [...z(), {
          baseline: ["", "last"]
        }]
      }],
      /**
       * Align Self
       * @see https://tailwindcss.com/docs/align-self
       */
      "align-self": [{
        self: ["auto", ...z(), {
          baseline: ["", "last"]
        }]
      }],
      /**
       * Place Content
       * @see https://tailwindcss.com/docs/place-content
       */
      "place-content": [{
        "place-content": J()
      }],
      /**
       * Place Items
       * @see https://tailwindcss.com/docs/place-items
       */
      "place-items": [{
        "place-items": [...z(), "baseline"]
      }],
      /**
       * Place Self
       * @see https://tailwindcss.com/docs/place-self
       */
      "place-self": [{
        "place-self": ["auto", ...z()]
      }],
      // Spacing
      /**
       * Padding
       * @see https://tailwindcss.com/docs/padding
       */
      p: [{
        p: A()
      }],
      /**
       * Padding X
       * @see https://tailwindcss.com/docs/padding
       */
      px: [{
        px: A()
      }],
      /**
       * Padding Y
       * @see https://tailwindcss.com/docs/padding
       */
      py: [{
        py: A()
      }],
      /**
       * Padding Start
       * @see https://tailwindcss.com/docs/padding
       */
      ps: [{
        ps: A()
      }],
      /**
       * Padding End
       * @see https://tailwindcss.com/docs/padding
       */
      pe: [{
        pe: A()
      }],
      /**
       * Padding Top
       * @see https://tailwindcss.com/docs/padding
       */
      pt: [{
        pt: A()
      }],
      /**
       * Padding Right
       * @see https://tailwindcss.com/docs/padding
       */
      pr: [{
        pr: A()
      }],
      /**
       * Padding Bottom
       * @see https://tailwindcss.com/docs/padding
       */
      pb: [{
        pb: A()
      }],
      /**
       * Padding Left
       * @see https://tailwindcss.com/docs/padding
       */
      pl: [{
        pl: A()
      }],
      /**
       * Margin
       * @see https://tailwindcss.com/docs/margin
       */
      m: [{
        m: j()
      }],
      /**
       * Margin X
       * @see https://tailwindcss.com/docs/margin
       */
      mx: [{
        mx: j()
      }],
      /**
       * Margin Y
       * @see https://tailwindcss.com/docs/margin
       */
      my: [{
        my: j()
      }],
      /**
       * Margin Start
       * @see https://tailwindcss.com/docs/margin
       */
      ms: [{
        ms: j()
      }],
      /**
       * Margin End
       * @see https://tailwindcss.com/docs/margin
       */
      me: [{
        me: j()
      }],
      /**
       * Margin Top
       * @see https://tailwindcss.com/docs/margin
       */
      mt: [{
        mt: j()
      }],
      /**
       * Margin Right
       * @see https://tailwindcss.com/docs/margin
       */
      mr: [{
        mr: j()
      }],
      /**
       * Margin Bottom
       * @see https://tailwindcss.com/docs/margin
       */
      mb: [{
        mb: j()
      }],
      /**
       * Margin Left
       * @see https://tailwindcss.com/docs/margin
       */
      ml: [{
        ml: j()
      }],
      /**
       * Space Between X
       * @see https://tailwindcss.com/docs/margin#adding-space-between-children
       */
      "space-x": [{
        "space-x": A()
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
        "space-y": A()
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
        size: U()
      }],
      /**
       * Width
       * @see https://tailwindcss.com/docs/width
       */
      w: [{
        w: [s, "screen", ...U()]
      }],
      /**
       * Min-Width
       * @see https://tailwindcss.com/docs/min-width
       */
      "min-w": [{
        "min-w": [
          s,
          "screen",
          /** Deprecated. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          "none",
          ...U()
        ]
      }],
      /**
       * Max-Width
       * @see https://tailwindcss.com/docs/max-width
       */
      "max-w": [{
        "max-w": [
          s,
          "screen",
          "none",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          "prose",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          {
            screen: [o]
          },
          ...U()
        ]
      }],
      /**
       * Height
       * @see https://tailwindcss.com/docs/height
       */
      h: [{
        h: ["screen", "lh", ...U()]
      }],
      /**
       * Min-Height
       * @see https://tailwindcss.com/docs/min-height
       */
      "min-h": [{
        "min-h": ["screen", "lh", "none", ...U()]
      }],
      /**
       * Max-Height
       * @see https://tailwindcss.com/docs/max-height
       */
      "max-h": [{
        "max-h": ["screen", "lh", ...U()]
      }],
      // ------------------
      // --- Typography ---
      // ------------------
      /**
       * Font Size
       * @see https://tailwindcss.com/docs/font-size
       */
      "font-size": [{
        text: ["base", n, _l, Fn]
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
        font: [a, B, hr]
      }],
      /**
       * Font Stretch
       * @see https://tailwindcss.com/docs/font-stretch
       */
      "font-stretch": [{
        "font-stretch": ["ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded", mr, L]
      }],
      /**
       * Font Family
       * @see https://tailwindcss.com/docs/font-family
       */
      "font-family": [{
        font: [Jx, L, t]
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
        tracking: [l, B, L]
      }],
      /**
       * Line Clamp
       * @see https://tailwindcss.com/docs/line-clamp
       */
      "line-clamp": [{
        "line-clamp": [Z, "none", B, hr]
      }],
      /**
       * Line Height
       * @see https://tailwindcss.com/docs/line-height
       */
      leading: [{
        leading: [
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          i,
          ...A()
        ]
      }],
      /**
       * List Style Image
       * @see https://tailwindcss.com/docs/list-style-image
       */
      "list-image": [{
        "list-image": ["none", B, L]
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
        list: ["disc", "decimal", "none", B, L]
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
        placeholder: D()
      }],
      /**
       * Text Color
       * @see https://tailwindcss.com/docs/text-color
       */
      "text-color": [{
        text: D()
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
        decoration: [...Qe(), "wavy"]
      }],
      /**
       * Text Decoration Thickness
       * @see https://tailwindcss.com/docs/text-decoration-thickness
       */
      "text-decoration-thickness": [{
        decoration: [Z, "from-font", "auto", B, Fn]
      }],
      /**
       * Text Decoration Color
       * @see https://tailwindcss.com/docs/text-decoration-color
       */
      "text-decoration-color": [{
        decoration: D()
      }],
      /**
       * Text Underline Offset
       * @see https://tailwindcss.com/docs/text-underline-offset
       */
      "underline-offset": [{
        "underline-offset": [Z, "auto", B, L]
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
        indent: A()
      }],
      /**
       * Vertical Alignment
       * @see https://tailwindcss.com/docs/vertical-align
       */
      "vertical-align": [{
        align: ["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super", B, L]
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
        content: ["none", B, L]
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
        bg: Q()
      }],
      /**
       * Background Repeat
       * @see https://tailwindcss.com/docs/background-repeat
       */
      "bg-repeat": [{
        bg: I()
      }],
      /**
       * Background Size
       * @see https://tailwindcss.com/docs/background-size
       */
      "bg-size": [{
        bg: Be()
      }],
      /**
       * Background Image
       * @see https://tailwindcss.com/docs/background-image
       */
      "bg-image": [{
        bg: ["none", {
          linear: [{
            to: ["t", "tr", "r", "br", "b", "bl", "l", "tl"]
          }, dn, B, L],
          radial: ["", B, L],
          conic: [dn, B, L]
        }, Wx, Kx]
      }],
      /**
       * Background Color
       * @see https://tailwindcss.com/docs/background-color
       */
      "bg-color": [{
        bg: D()
      }],
      /**
       * Gradient Color Stops From Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from-pos": [{
        from: we()
      }],
      /**
       * Gradient Color Stops Via Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via-pos": [{
        via: we()
      }],
      /**
       * Gradient Color Stops To Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to-pos": [{
        to: we()
      }],
      /**
       * Gradient Color Stops From
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from": [{
        from: D()
      }],
      /**
       * Gradient Color Stops Via
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via": [{
        via: D()
      }],
      /**
       * Gradient Color Stops To
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to": [{
        to: D()
      }],
      // ---------------
      // --- Borders ---
      // ---------------
      /**
       * Border Radius
       * @see https://tailwindcss.com/docs/border-radius
       */
      rounded: [{
        rounded: ie()
      }],
      /**
       * Border Radius Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-s": [{
        "rounded-s": ie()
      }],
      /**
       * Border Radius End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-e": [{
        "rounded-e": ie()
      }],
      /**
       * Border Radius Top
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-t": [{
        "rounded-t": ie()
      }],
      /**
       * Border Radius Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-r": [{
        "rounded-r": ie()
      }],
      /**
       * Border Radius Bottom
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-b": [{
        "rounded-b": ie()
      }],
      /**
       * Border Radius Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-l": [{
        "rounded-l": ie()
      }],
      /**
       * Border Radius Start Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ss": [{
        "rounded-ss": ie()
      }],
      /**
       * Border Radius Start End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-se": [{
        "rounded-se": ie()
      }],
      /**
       * Border Radius End End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ee": [{
        "rounded-ee": ie()
      }],
      /**
       * Border Radius End Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-es": [{
        "rounded-es": ie()
      }],
      /**
       * Border Radius Top Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tl": [{
        "rounded-tl": ie()
      }],
      /**
       * Border Radius Top Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tr": [{
        "rounded-tr": ie()
      }],
      /**
       * Border Radius Bottom Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-br": [{
        "rounded-br": ie()
      }],
      /**
       * Border Radius Bottom Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-bl": [{
        "rounded-bl": ie()
      }],
      /**
       * Border Width
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w": [{
        border: ne()
      }],
      /**
       * Border Width X
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-x": [{
        "border-x": ne()
      }],
      /**
       * Border Width Y
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-y": [{
        "border-y": ne()
      }],
      /**
       * Border Width Start
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-s": [{
        "border-s": ne()
      }],
      /**
       * Border Width End
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-e": [{
        "border-e": ne()
      }],
      /**
       * Border Width Top
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-t": [{
        "border-t": ne()
      }],
      /**
       * Border Width Right
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-r": [{
        "border-r": ne()
      }],
      /**
       * Border Width Bottom
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-b": [{
        "border-b": ne()
      }],
      /**
       * Border Width Left
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-l": [{
        "border-l": ne()
      }],
      /**
       * Divide Width X
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-x": [{
        "divide-x": ne()
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
        "divide-y": ne()
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
        border: [...Qe(), "hidden", "none"]
      }],
      /**
       * Divide Style
       * @see https://tailwindcss.com/docs/border-style#setting-the-divider-style
       */
      "divide-style": [{
        divide: [...Qe(), "hidden", "none"]
      }],
      /**
       * Border Color
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color": [{
        border: D()
      }],
      /**
       * Border Color X
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-x": [{
        "border-x": D()
      }],
      /**
       * Border Color Y
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-y": [{
        "border-y": D()
      }],
      /**
       * Border Color S
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-s": [{
        "border-s": D()
      }],
      /**
       * Border Color E
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-e": [{
        "border-e": D()
      }],
      /**
       * Border Color Top
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-t": [{
        "border-t": D()
      }],
      /**
       * Border Color Right
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-r": [{
        "border-r": D()
      }],
      /**
       * Border Color Bottom
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-b": [{
        "border-b": D()
      }],
      /**
       * Border Color Left
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-l": [{
        "border-l": D()
      }],
      /**
       * Divide Color
       * @see https://tailwindcss.com/docs/divide-color
       */
      "divide-color": [{
        divide: D()
      }],
      /**
       * Outline Style
       * @see https://tailwindcss.com/docs/outline-style
       */
      "outline-style": [{
        outline: [...Qe(), "none", "hidden"]
      }],
      /**
       * Outline Offset
       * @see https://tailwindcss.com/docs/outline-offset
       */
      "outline-offset": [{
        "outline-offset": [Z, B, L]
      }],
      /**
       * Outline Width
       * @see https://tailwindcss.com/docs/outline-width
       */
      "outline-w": [{
        outline: ["", Z, _l, Fn]
      }],
      /**
       * Outline Color
       * @see https://tailwindcss.com/docs/outline-color
       */
      "outline-color": [{
        outline: D()
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
          m,
          Fi,
          Zi
        ]
      }],
      /**
       * Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-shadow-color
       */
      "shadow-color": [{
        shadow: D()
      }],
      /**
       * Inset Box Shadow
       * @see https://tailwindcss.com/docs/box-shadow#adding-an-inset-shadow
       */
      "inset-shadow": [{
        "inset-shadow": ["none", g, Fi, Zi]
      }],
      /**
       * Inset Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-inset-shadow-color
       */
      "inset-shadow-color": [{
        "inset-shadow": D()
      }],
      /**
       * Ring Width
       * @see https://tailwindcss.com/docs/box-shadow#adding-a-ring
       */
      "ring-w": [{
        ring: ne()
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
        ring: D()
      }],
      /**
       * Ring Offset Width
       * @see https://v3.tailwindcss.com/docs/ring-offset-width
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-offset-w": [{
        "ring-offset": [Z, Fn]
      }],
      /**
       * Ring Offset Color
       * @see https://v3.tailwindcss.com/docs/ring-offset-color
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-offset-color": [{
        "ring-offset": D()
      }],
      /**
       * Inset Ring Width
       * @see https://tailwindcss.com/docs/box-shadow#adding-an-inset-ring
       */
      "inset-ring-w": [{
        "inset-ring": ne()
      }],
      /**
       * Inset Ring Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-inset-ring-color
       */
      "inset-ring-color": [{
        "inset-ring": D()
      }],
      /**
       * Text Shadow
       * @see https://tailwindcss.com/docs/text-shadow
       */
      "text-shadow": [{
        "text-shadow": ["none", f, Fi, Zi]
      }],
      /**
       * Text Shadow Color
       * @see https://tailwindcss.com/docs/text-shadow#setting-the-shadow-color
       */
      "text-shadow-color": [{
        "text-shadow": D()
      }],
      /**
       * Opacity
       * @see https://tailwindcss.com/docs/opacity
       */
      opacity: [{
        opacity: [Z, B, L]
      }],
      /**
       * Mix Blend Mode
       * @see https://tailwindcss.com/docs/mix-blend-mode
       */
      "mix-blend": [{
        "mix-blend": [...ln(), "plus-darker", "plus-lighter"]
      }],
      /**
       * Background Blend Mode
       * @see https://tailwindcss.com/docs/background-blend-mode
       */
      "bg-blend": [{
        "bg-blend": ln()
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
        "mask-linear": [Z]
      }],
      "mask-image-linear-from-pos": [{
        "mask-linear-from": ye()
      }],
      "mask-image-linear-to-pos": [{
        "mask-linear-to": ye()
      }],
      "mask-image-linear-from-color": [{
        "mask-linear-from": D()
      }],
      "mask-image-linear-to-color": [{
        "mask-linear-to": D()
      }],
      "mask-image-t-from-pos": [{
        "mask-t-from": ye()
      }],
      "mask-image-t-to-pos": [{
        "mask-t-to": ye()
      }],
      "mask-image-t-from-color": [{
        "mask-t-from": D()
      }],
      "mask-image-t-to-color": [{
        "mask-t-to": D()
      }],
      "mask-image-r-from-pos": [{
        "mask-r-from": ye()
      }],
      "mask-image-r-to-pos": [{
        "mask-r-to": ye()
      }],
      "mask-image-r-from-color": [{
        "mask-r-from": D()
      }],
      "mask-image-r-to-color": [{
        "mask-r-to": D()
      }],
      "mask-image-b-from-pos": [{
        "mask-b-from": ye()
      }],
      "mask-image-b-to-pos": [{
        "mask-b-to": ye()
      }],
      "mask-image-b-from-color": [{
        "mask-b-from": D()
      }],
      "mask-image-b-to-color": [{
        "mask-b-to": D()
      }],
      "mask-image-l-from-pos": [{
        "mask-l-from": ye()
      }],
      "mask-image-l-to-pos": [{
        "mask-l-to": ye()
      }],
      "mask-image-l-from-color": [{
        "mask-l-from": D()
      }],
      "mask-image-l-to-color": [{
        "mask-l-to": D()
      }],
      "mask-image-x-from-pos": [{
        "mask-x-from": ye()
      }],
      "mask-image-x-to-pos": [{
        "mask-x-to": ye()
      }],
      "mask-image-x-from-color": [{
        "mask-x-from": D()
      }],
      "mask-image-x-to-color": [{
        "mask-x-to": D()
      }],
      "mask-image-y-from-pos": [{
        "mask-y-from": ye()
      }],
      "mask-image-y-to-pos": [{
        "mask-y-to": ye()
      }],
      "mask-image-y-from-color": [{
        "mask-y-from": D()
      }],
      "mask-image-y-to-color": [{
        "mask-y-to": D()
      }],
      "mask-image-radial": [{
        "mask-radial": [B, L]
      }],
      "mask-image-radial-from-pos": [{
        "mask-radial-from": ye()
      }],
      "mask-image-radial-to-pos": [{
        "mask-radial-to": ye()
      }],
      "mask-image-radial-from-color": [{
        "mask-radial-from": D()
      }],
      "mask-image-radial-to-color": [{
        "mask-radial-to": D()
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
        "mask-radial-at": b()
      }],
      "mask-image-conic-pos": [{
        "mask-conic": [Z]
      }],
      "mask-image-conic-from-pos": [{
        "mask-conic-from": ye()
      }],
      "mask-image-conic-to-pos": [{
        "mask-conic-to": ye()
      }],
      "mask-image-conic-from-color": [{
        "mask-conic-from": D()
      }],
      "mask-image-conic-to-color": [{
        "mask-conic-to": D()
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
        mask: Q()
      }],
      /**
       * Mask Repeat
       * @see https://tailwindcss.com/docs/mask-repeat
       */
      "mask-repeat": [{
        mask: I()
      }],
      /**
       * Mask Size
       * @see https://tailwindcss.com/docs/mask-size
       */
      "mask-size": [{
        mask: Be()
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
        mask: ["none", B, L]
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
          B,
          L
        ]
      }],
      /**
       * Blur
       * @see https://tailwindcss.com/docs/blur
       */
      blur: [{
        blur: ga()
      }],
      /**
       * Brightness
       * @see https://tailwindcss.com/docs/brightness
       */
      brightness: [{
        brightness: [Z, B, L]
      }],
      /**
       * Contrast
       * @see https://tailwindcss.com/docs/contrast
       */
      contrast: [{
        contrast: [Z, B, L]
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
          p,
          Fi,
          Zi
        ]
      }],
      /**
       * Drop Shadow Color
       * @see https://tailwindcss.com/docs/filter-drop-shadow#setting-the-shadow-color
       */
      "drop-shadow-color": [{
        "drop-shadow": D()
      }],
      /**
       * Grayscale
       * @see https://tailwindcss.com/docs/grayscale
       */
      grayscale: [{
        grayscale: ["", Z, B, L]
      }],
      /**
       * Hue Rotate
       * @see https://tailwindcss.com/docs/hue-rotate
       */
      "hue-rotate": [{
        "hue-rotate": [Z, B, L]
      }],
      /**
       * Invert
       * @see https://tailwindcss.com/docs/invert
       */
      invert: [{
        invert: ["", Z, B, L]
      }],
      /**
       * Saturate
       * @see https://tailwindcss.com/docs/saturate
       */
      saturate: [{
        saturate: [Z, B, L]
      }],
      /**
       * Sepia
       * @see https://tailwindcss.com/docs/sepia
       */
      sepia: [{
        sepia: ["", Z, B, L]
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
          B,
          L
        ]
      }],
      /**
       * Backdrop Blur
       * @see https://tailwindcss.com/docs/backdrop-blur
       */
      "backdrop-blur": [{
        "backdrop-blur": ga()
      }],
      /**
       * Backdrop Brightness
       * @see https://tailwindcss.com/docs/backdrop-brightness
       */
      "backdrop-brightness": [{
        "backdrop-brightness": [Z, B, L]
      }],
      /**
       * Backdrop Contrast
       * @see https://tailwindcss.com/docs/backdrop-contrast
       */
      "backdrop-contrast": [{
        "backdrop-contrast": [Z, B, L]
      }],
      /**
       * Backdrop Grayscale
       * @see https://tailwindcss.com/docs/backdrop-grayscale
       */
      "backdrop-grayscale": [{
        "backdrop-grayscale": ["", Z, B, L]
      }],
      /**
       * Backdrop Hue Rotate
       * @see https://tailwindcss.com/docs/backdrop-hue-rotate
       */
      "backdrop-hue-rotate": [{
        "backdrop-hue-rotate": [Z, B, L]
      }],
      /**
       * Backdrop Invert
       * @see https://tailwindcss.com/docs/backdrop-invert
       */
      "backdrop-invert": [{
        "backdrop-invert": ["", Z, B, L]
      }],
      /**
       * Backdrop Opacity
       * @see https://tailwindcss.com/docs/backdrop-opacity
       */
      "backdrop-opacity": [{
        "backdrop-opacity": [Z, B, L]
      }],
      /**
       * Backdrop Saturate
       * @see https://tailwindcss.com/docs/backdrop-saturate
       */
      "backdrop-saturate": [{
        "backdrop-saturate": [Z, B, L]
      }],
      /**
       * Backdrop Sepia
       * @see https://tailwindcss.com/docs/backdrop-sepia
       */
      "backdrop-sepia": [{
        "backdrop-sepia": ["", Z, B, L]
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
        "border-spacing": A()
      }],
      /**
       * Border Spacing X
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-x": [{
        "border-spacing-x": A()
      }],
      /**
       * Border Spacing Y
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-y": [{
        "border-spacing-y": A()
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
        transition: ["", "all", "colors", "opacity", "shadow", "transform", "none", B, L]
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
        duration: [Z, "initial", B, L]
      }],
      /**
       * Transition Timing Function
       * @see https://tailwindcss.com/docs/transition-timing-function
       */
      ease: [{
        ease: ["linear", "initial", h, B, L]
      }],
      /**
       * Transition Delay
       * @see https://tailwindcss.com/docs/transition-delay
       */
      delay: [{
        delay: [Z, B, L]
      }],
      /**
       * Animation
       * @see https://tailwindcss.com/docs/animation
       */
      animate: [{
        animate: ["none", d, B, L]
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
        perspective: [x, B, L]
      }],
      /**
       * Perspective Origin
       * @see https://tailwindcss.com/docs/perspective-origin
       */
      "perspective-origin": [{
        "perspective-origin": N()
      }],
      /**
       * Rotate
       * @see https://tailwindcss.com/docs/rotate
       */
      rotate: [{
        rotate: on()
      }],
      /**
       * Rotate X
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-x": [{
        "rotate-x": on()
      }],
      /**
       * Rotate Y
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-y": [{
        "rotate-y": on()
      }],
      /**
       * Rotate Z
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-z": [{
        "rotate-z": on()
      }],
      /**
       * Scale
       * @see https://tailwindcss.com/docs/scale
       */
      scale: [{
        scale: sn()
      }],
      /**
       * Scale X
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-x": [{
        "scale-x": sn()
      }],
      /**
       * Scale Y
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-y": [{
        "scale-y": sn()
      }],
      /**
       * Scale Z
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-z": [{
        "scale-z": sn()
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
        skew: rn()
      }],
      /**
       * Skew X
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-x": [{
        "skew-x": rn()
      }],
      /**
       * Skew Y
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-y": [{
        "skew-y": rn()
      }],
      /**
       * Transform
       * @see https://tailwindcss.com/docs/transform
       */
      transform: [{
        transform: [B, L, "", "none", "gpu", "cpu"]
      }],
      /**
       * Transform Origin
       * @see https://tailwindcss.com/docs/transform-origin
       */
      "transform-origin": [{
        origin: N()
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
        translate: cn()
      }],
      /**
       * Translate X
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-x": [{
        "translate-x": cn()
      }],
      /**
       * Translate Y
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-y": [{
        "translate-y": cn()
      }],
      /**
       * Translate Z
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-z": [{
        "translate-z": cn()
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
        accent: D()
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
        caret: D()
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
        cursor: ["auto", "default", "pointer", "wait", "text", "move", "help", "not-allowed", "none", "context-menu", "progress", "cell", "crosshair", "vertical-text", "alias", "copy", "no-drop", "grab", "grabbing", "all-scroll", "col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out", B, L]
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
        "scroll-m": A()
      }],
      /**
       * Scroll Margin X
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mx": [{
        "scroll-mx": A()
      }],
      /**
       * Scroll Margin Y
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-my": [{
        "scroll-my": A()
      }],
      /**
       * Scroll Margin Start
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ms": [{
        "scroll-ms": A()
      }],
      /**
       * Scroll Margin End
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-me": [{
        "scroll-me": A()
      }],
      /**
       * Scroll Margin Top
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mt": [{
        "scroll-mt": A()
      }],
      /**
       * Scroll Margin Right
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mr": [{
        "scroll-mr": A()
      }],
      /**
       * Scroll Margin Bottom
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mb": [{
        "scroll-mb": A()
      }],
      /**
       * Scroll Margin Left
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ml": [{
        "scroll-ml": A()
      }],
      /**
       * Scroll Padding
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-p": [{
        "scroll-p": A()
      }],
      /**
       * Scroll Padding X
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-px": [{
        "scroll-px": A()
      }],
      /**
       * Scroll Padding Y
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-py": [{
        "scroll-py": A()
      }],
      /**
       * Scroll Padding Start
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-ps": [{
        "scroll-ps": A()
      }],
      /**
       * Scroll Padding End
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pe": [{
        "scroll-pe": A()
      }],
      /**
       * Scroll Padding Top
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pt": [{
        "scroll-pt": A()
      }],
      /**
       * Scroll Padding Right
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pr": [{
        "scroll-pr": A()
      }],
      /**
       * Scroll Padding Bottom
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pb": [{
        "scroll-pb": A()
      }],
      /**
       * Scroll Padding Left
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pl": [{
        "scroll-pl": A()
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
        "will-change": ["auto", "scroll", "contents", "transform", B, L]
      }],
      // -----------
      // --- SVG ---
      // -----------
      /**
       * Fill
       * @see https://tailwindcss.com/docs/fill
       */
      fill: [{
        fill: ["none", ...D()]
      }],
      /**
       * Stroke Width
       * @see https://tailwindcss.com/docs/stroke-width
       */
      "stroke-w": [{
        stroke: [Z, _l, Fn, hr]
      }],
      /**
       * Stroke
       * @see https://tailwindcss.com/docs/stroke
       */
      stroke: [{
        stroke: ["none", ...D()]
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
}, tS = /* @__PURE__ */ Rx(eS);
function te(...e) {
  return tS(av(e));
}
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const nS = (e) => e.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), aS = (e) => e.replace(
  /^([A-Z])|[\s-_]+(\w)/g,
  (t, n, a) => a ? a.toUpperCase() : n.toLowerCase()
), _d = (e) => {
  const t = aS(e);
  return t.charAt(0).toUpperCase() + t.slice(1);
}, vv = (...e) => e.filter((t, n, a) => !!t && t.trim() !== "" && a.indexOf(t) === n).join(" ").trim(), lS = (e) => {
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
var iS = {
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
const oS = v.forwardRef(
  ({
    color: e = "currentColor",
    size: t = 24,
    strokeWidth: n = 2,
    absoluteStrokeWidth: a,
    className: l = "",
    children: i,
    iconNode: o,
    ...s
  }, c) => v.createElement(
    "svg",
    {
      ref: c,
      ...iS,
      width: t,
      height: t,
      stroke: e,
      strokeWidth: a ? Number(n) * 24 / Number(t) : n,
      className: vv("lucide", l),
      ...!i && !lS(s) && { "aria-hidden": "true" },
      ...s
    },
    [
      ...o.map(([u, m]) => v.createElement(u, m)),
      ...Array.isArray(i) ? i : [i]
    ]
  )
);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const K = (e, t) => {
  const n = v.forwardRef(
    ({ className: a, ...l }, i) => v.createElement(oS, {
      ref: i,
      iconNode: t,
      className: vv(
        `lucide-${nS(_d(e))}`,
        `lucide-${e}`,
        a
      ),
      ...l
    })
  );
  return n.displayName = _d(e), n;
};
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const sS = [
  [
    "path",
    {
      d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
      key: "hh9hay"
    }
  ],
  ["path", { d: "m3.3 7 8.7 5 8.7-5", key: "g66t2b" }],
  ["path", { d: "M12 22V12", key: "d0xqtd" }]
], pv = K("box", sS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const rS = [
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
], ps = K("brain", rS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const cS = [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]], uS = K("check", cS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const fS = [["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]], dS = K("chevron-down", fS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const mS = [["path", { d: "m18 15-6-6-6 6", key: "153udz" }]], hS = K("chevron-up", mS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const gS = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["circle", { cx: "12", cy: "12", r: "1", key: "41hilf" }]
], vS = K("circle-dot", gS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const pS = [["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }]], yS = K("circle", pS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const bS = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M9 3v18", key: "fh3hqa" }],
  ["path", { d: "M15 3v18", key: "14nvp0" }]
], xS = K("columns-3", bS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const SS = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "M12 18a6 6 0 0 0 0-12v12z", key: "j4l70d" }]
], Od = K("contrast", SS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const CS = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["line", { x1: "22", x2: "18", y1: "12", y2: "12", key: "l9bcsi" }],
  ["line", { x1: "6", x2: "2", y1: "12", y2: "12", key: "13hhkx" }],
  ["line", { x1: "12", x2: "12", y1: "6", y2: "2", key: "10w3f3" }],
  ["line", { x1: "12", x2: "12", y1: "22", y2: "18", key: "15g9kq" }]
], zd = K("crosshair", CS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const wS = [
  ["ellipse", { cx: "12", cy: "5", rx: "9", ry: "3", key: "msslwz" }],
  ["path", { d: "M3 5V19A9 3 0 0 0 21 19V5", key: "1wlel7" }],
  ["path", { d: "M3 12A9 3 0 0 0 21 12", key: "mv7ke4" }]
], AS = K("database", wS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const NS = [
  ["path", { d: "M12 15V3", key: "m9g1x1" }],
  ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", key: "ih7n3h" }],
  ["path", { d: "m7 10 5 5 5-5", key: "brsn70" }]
], ES = K("download", NS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const jS = [
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
], Cu = K("eye-off", jS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const MS = [
  [
    "path",
    {
      d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
      key: "1nclc0"
    }
  ],
  ["circle", { cx: "12", cy: "12", r: "3", key: "1v7zrd" }]
], wu = K("eye", MS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const TS = [
  ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", key: "1rqfz7" }],
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }],
  ["path", { d: "M10 9H8", key: "b1mrlr" }],
  ["path", { d: "M16 13H8", key: "t4e002" }],
  ["path", { d: "M16 17H8", key: "z1uh3a" }]
], DS = K("file-text", TS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const _S = [
  ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", key: "1rqfz7" }],
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }]
], OS = K("file", _S);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const zS = [
  ["path", { d: "M12 3v18", key: "108xh3" }],
  ["path", { d: "M3 12h18", key: "1i2n21" }],
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2", key: "h1oib" }]
], RS = K("grid-2x2", zS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const kS = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2", key: "1m3agn" }],
  ["circle", { cx: "9", cy: "9", r: "2", key: "af1f0g" }],
  ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21", key: "1xmnt7" }]
], US = K("image", kS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const VS = [
  ["path", { d: "m16 17 5-5-5-5", key: "1bji2h" }],
  ["path", { d: "M21 12H9", key: "dn1m92" }],
  ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", key: "1uf3rs" }]
], LS = K("log-out", VS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const BS = [
  ["path", { d: "M15 3h6v6", key: "1q9fwt" }],
  ["path", { d: "m21 3-7 7", key: "1l2asr" }],
  ["path", { d: "m3 21 7-7", key: "tjx5ai" }],
  ["path", { d: "M9 21H3v-6", key: "wtvkvv" }]
], HS = K("maximize-2", BS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const GS = [
  ["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z", key: "a7tn18" }]
], YS = K("moon", GS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const qS = [
  ["path", { d: "M12.586 12.586 19 19", key: "ea5xo7" }],
  [
    "path",
    {
      d: "M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z",
      key: "277e5u"
    }
  ]
], XS = K("mouse-pointer", qS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const QS = [
  ["path", { d: "M12 2v20", key: "t6zp3m" }],
  ["path", { d: "m15 19-3 3-3-3", key: "11eu04" }],
  ["path", { d: "m19 9 3 3-3 3", key: "1mg7y2" }],
  ["path", { d: "M2 12h20", key: "9i4pu4" }],
  ["path", { d: "m5 9-3 3 3 3", key: "j64kie" }],
  ["path", { d: "m9 5 3-3 3 3", key: "l8vdw6" }]
], Rd = K("move", QS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const ZS = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M3 15h18", key: "5xshup" }]
], FS = K("panel-bottom", ZS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const KS = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M9 3v18", key: "fh3hqa" }]
], JS = K("panel-left", KS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const IS = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M15 3v18", key: "14nvp0" }]
], WS = K("panel-right", IS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const $S = [
  [
    "path",
    {
      d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      key: "1a8usu"
    }
  ],
  ["path", { d: "m15 5 4 4", key: "1mk7zo" }]
], Au = K("pencil", $S);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const PS = [
  ["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "1357e3" }],
  ["path", { d: "M3 3v5h5", key: "1xhq8a" }]
], e2 = K("rotate-ccw", PS);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const t2 = [
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
], n2 = K("ruler", t2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const a2 = [
  [
    "path",
    {
      d: "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
      key: "1c8476"
    }
  ],
  ["path", { d: "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7", key: "1ydtos" }],
  ["path", { d: "M7 3v4a1 1 0 0 0 1 1h7", key: "t51u73" }]
], yv = K("save", a2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const l2 = [
  [
    "path",
    {
      d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      key: "1qme2f"
    }
  ],
  ["circle", { cx: "12", cy: "12", r: "3", key: "1v7zrd" }]
], i2 = K("settings", l2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const o2 = [
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
], s2 = K("sparkles", o2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const r2 = [
  ["path", { d: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", key: "1m0v6g" }],
  [
    "path",
    {
      d: "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
      key: "ohrbg2"
    }
  ]
], c2 = K("square-pen", r2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const u2 = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }]
], f2 = K("square", u2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const d2 = [
  ["circle", { cx: "12", cy: "12", r: "4", key: "4exip2" }],
  ["path", { d: "M12 2v2", key: "tus03m" }],
  ["path", { d: "M12 20v2", key: "1lh1kg" }],
  ["path", { d: "m4.93 4.93 1.41 1.41", key: "149t6j" }],
  ["path", { d: "m17.66 17.66 1.41 1.41", key: "ptbguv" }],
  ["path", { d: "M2 12h2", key: "1t8f8n" }],
  ["path", { d: "M20 12h2", key: "1q8mjw" }],
  ["path", { d: "m6.34 17.66-1.41 1.41", key: "1m8zz5" }],
  ["path", { d: "m19.07 4.93-1.41 1.41", key: "1shlcs" }]
], m2 = K("sun", d2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const h2 = [
  ["path", { d: "M3 6h18", key: "d0wm0j" }],
  ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", key: "4alrt4" }],
  ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", key: "v07s0e" }],
  ["line", { x1: "10", x2: "10", y1: "11", y2: "17", key: "1uufr5" }],
  ["line", { x1: "14", x2: "14", y1: "11", y2: "17", key: "xtxkd" }]
], Fo = K("trash-2", h2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const g2 = [
  ["path", { d: "M3 7v6h6", key: "1v2h90" }],
  ["path", { d: "M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13", key: "1r6uu6" }]
], bv = K("undo", g2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const v2 = [
  ["path", { d: "M12 3v12", key: "1x0j5s" }],
  ["path", { d: "m17 8-5-5-5 5", key: "7q97r8" }],
  ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", key: "ih7n3h" }]
], fi = K("upload", v2);
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const p2 = [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
], y2 = K("x", p2);
function kd(e, t) {
  if (typeof e == "function")
    return e(t);
  e != null && (e.current = t);
}
function ys(...e) {
  return (t) => {
    let n = !1;
    const a = e.map((l) => {
      const i = kd(l, t);
      return !n && typeof i == "function" && (n = !0), i;
    });
    if (n)
      return () => {
        for (let l = 0; l < a.length; l++) {
          const i = a[l];
          typeof i == "function" ? i() : kd(e[l], null);
        }
      };
  };
}
function Ee(...e) {
  return v.useCallback(ys(...e), e);
}
var b2 = Symbol.for("react.lazy"), Ko = wc[" use ".trim().toString()];
function x2(e) {
  return typeof e == "object" && e !== null && "then" in e;
}
function xv(e) {
  return e != null && typeof e == "object" && "$$typeof" in e && e.$$typeof === b2 && "_payload" in e && x2(e._payload);
}
// @__NO_SIDE_EFFECTS__
function Sv(e) {
  const t = /* @__PURE__ */ C2(e), n = v.forwardRef((a, l) => {
    let { children: i, ...o } = a;
    xv(i) && typeof Ko == "function" && (i = Ko(i._payload));
    const s = v.Children.toArray(i), c = s.find(A2);
    if (c) {
      const u = c.props.children, m = s.map((g) => g === c ? v.Children.count(u) > 1 ? v.Children.only(null) : v.isValidElement(u) ? u.props.children : null : g);
      return /* @__PURE__ */ r.jsx(t, { ...o, ref: l, children: v.isValidElement(u) ? v.cloneElement(u, void 0, m) : null });
    }
    return /* @__PURE__ */ r.jsx(t, { ...o, ref: l, children: i });
  });
  return n.displayName = `${e}.Slot`, n;
}
var S2 = /* @__PURE__ */ Sv("Slot");
// @__NO_SIDE_EFFECTS__
function C2(e) {
  const t = v.forwardRef((n, a) => {
    let { children: l, ...i } = n;
    if (xv(l) && typeof Ko == "function" && (l = Ko(l._payload)), v.isValidElement(l)) {
      const o = E2(l), s = N2(i, l.props);
      return l.type !== v.Fragment && (s.ref = a ? ys(a, o) : o), v.cloneElement(l, s);
    }
    return v.Children.count(l) > 1 ? v.Children.only(null) : null;
  });
  return t.displayName = `${e}.SlotClone`, t;
}
var w2 = Symbol("radix.slottable");
function A2(e) {
  return v.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === w2;
}
function N2(e, t) {
  const n = { ...t };
  for (const a in t) {
    const l = e[a], i = t[a];
    /^on[A-Z]/.test(a) ? l && i ? n[a] = (...s) => {
      const c = i(...s);
      return l(...s), c;
    } : l && (n[a] = l) : a === "style" ? n[a] = { ...l, ...i } : a === "className" && (n[a] = [l, i].filter(Boolean).join(" "));
  }
  return { ...e, ...n };
}
function E2(e) {
  var a, l;
  let t = (a = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : a.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (l = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : l.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
const Ud = (e) => typeof e == "boolean" ? `${e}` : e === 0 ? "0" : e, Vd = av, Cv = (e, t) => (n) => {
  var a;
  if ((t == null ? void 0 : t.variants) == null) return Vd(e, n == null ? void 0 : n.class, n == null ? void 0 : n.className);
  const { variants: l, defaultVariants: i } = t, o = Object.keys(l).map((u) => {
    const m = n == null ? void 0 : n[u], g = i == null ? void 0 : i[u];
    if (m === null) return null;
    const f = Ud(m) || Ud(g);
    return l[u][f];
  }), s = n && Object.entries(n).reduce((u, m) => {
    let [g, f] = m;
    return f === void 0 || (u[g] = f), u;
  }, {}), c = t == null || (a = t.compoundVariants) === null || a === void 0 ? void 0 : a.reduce((u, m) => {
    let { class: g, className: f, ...p } = m;
    return Object.entries(p).every((C) => {
      let [x, S] = C;
      return Array.isArray(S) ? S.includes({
        ...i,
        ...s
      }[x]) : {
        ...i,
        ...s
      }[x] === S;
    }) ? [
      ...u,
      g,
      f
    ] : u;
  }, []);
  return Vd(e, o, c, n == null ? void 0 : n.class, n == null ? void 0 : n.className);
}, j2 = Cv(
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
function q({
  className: e,
  variant: t,
  size: n,
  asChild: a = !1,
  ...l
}) {
  const i = a ? S2 : "button";
  return /* @__PURE__ */ r.jsx(
    i,
    {
      "data-slot": "button",
      className: te(j2({ variant: t, size: n, className: e })),
      ...l
    }
  );
}
function an(e, t = []) {
  let n = [];
  function a(i, o) {
    const s = v.createContext(o), c = n.length;
    n = [...n, o];
    const u = (g) => {
      var h;
      const { scope: f, children: p, ...C } = g, x = ((h = f == null ? void 0 : f[e]) == null ? void 0 : h[c]) || s, S = v.useMemo(() => C, Object.values(C));
      return /* @__PURE__ */ r.jsx(x.Provider, { value: S, children: p });
    };
    u.displayName = i + "Provider";
    function m(g, f) {
      var x;
      const p = ((x = f == null ? void 0 : f[e]) == null ? void 0 : x[c]) || s, C = v.useContext(p);
      if (C) return C;
      if (o !== void 0) return o;
      throw new Error(`\`${g}\` must be used within \`${i}\``);
    }
    return [u, m];
  }
  const l = () => {
    const i = n.map((o) => v.createContext(o));
    return function(s) {
      const c = (s == null ? void 0 : s[e]) || i;
      return v.useMemo(
        () => ({ [`__scope${e}`]: { ...s, [e]: c } }),
        [s, c]
      );
    };
  };
  return l.scopeName = e, [a, M2(l, ...t)];
}
function M2(...e) {
  const t = e[0];
  if (e.length === 1) return t;
  const n = () => {
    const a = e.map((l) => ({
      useScope: l(),
      scopeName: l.scopeName
    }));
    return function(i) {
      const o = a.reduce((s, { useScope: c, scopeName: u }) => {
        const g = c(i)[`__scope${u}`];
        return { ...s, ...g };
      }, {});
      return v.useMemo(() => ({ [`__scope${t.scopeName}`]: o }), [o]);
    };
  };
  return n.scopeName = t.scopeName, n;
}
// @__NO_SIDE_EFFECTS__
function T2(e) {
  const t = /* @__PURE__ */ D2(e), n = v.forwardRef((a, l) => {
    const { children: i, ...o } = a, s = v.Children.toArray(i), c = s.find(O2);
    if (c) {
      const u = c.props.children, m = s.map((g) => g === c ? v.Children.count(u) > 1 ? v.Children.only(null) : v.isValidElement(u) ? u.props.children : null : g);
      return /* @__PURE__ */ r.jsx(t, { ...o, ref: l, children: v.isValidElement(u) ? v.cloneElement(u, void 0, m) : null });
    }
    return /* @__PURE__ */ r.jsx(t, { ...o, ref: l, children: i });
  });
  return n.displayName = `${e}.Slot`, n;
}
// @__NO_SIDE_EFFECTS__
function D2(e) {
  const t = v.forwardRef((n, a) => {
    const { children: l, ...i } = n;
    if (v.isValidElement(l)) {
      const o = R2(l), s = z2(i, l.props);
      return l.type !== v.Fragment && (s.ref = a ? ys(a, o) : o), v.cloneElement(l, s);
    }
    return v.Children.count(l) > 1 ? v.Children.only(null) : null;
  });
  return t.displayName = `${e}.SlotClone`, t;
}
var _2 = Symbol("radix.slottable");
function O2(e) {
  return v.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === _2;
}
function z2(e, t) {
  const n = { ...t };
  for (const a in t) {
    const l = e[a], i = t[a];
    /^on[A-Z]/.test(a) ? l && i ? n[a] = (...s) => {
      const c = i(...s);
      return l(...s), c;
    } : l && (n[a] = l) : a === "style" ? n[a] = { ...l, ...i } : a === "className" && (n[a] = [l, i].filter(Boolean).join(" "));
  }
  return { ...e, ...n };
}
function R2(e) {
  var a, l;
  let t = (a = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : a.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (l = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : l.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
var k2 = [
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
], me = k2.reduce((e, t) => {
  const n = /* @__PURE__ */ T2(`Primitive.${t}`), a = v.forwardRef((l, i) => {
    const { asChild: o, ...s } = l, c = o ? n : t;
    return typeof window < "u" && (window[Symbol.for("radix-ui")] = !0), /* @__PURE__ */ r.jsx(c, { ...s, ref: i });
  });
  return a.displayName = `Primitive.${t}`, { ...e, [t]: a };
}, {});
function ue(e, t, { checkForDefaultPrevented: n = !0 } = {}) {
  return function(l) {
    if (e == null || e(l), n === !1 || !l.defaultPrevented)
      return t == null ? void 0 : t(l);
  };
}
// @__NO_SIDE_EFFECTS__
function Ld(e) {
  const t = /* @__PURE__ */ U2(e), n = v.forwardRef((a, l) => {
    const { children: i, ...o } = a, s = v.Children.toArray(i), c = s.find(L2);
    if (c) {
      const u = c.props.children, m = s.map((g) => g === c ? v.Children.count(u) > 1 ? v.Children.only(null) : v.isValidElement(u) ? u.props.children : null : g);
      return /* @__PURE__ */ r.jsx(t, { ...o, ref: l, children: v.isValidElement(u) ? v.cloneElement(u, void 0, m) : null });
    }
    return /* @__PURE__ */ r.jsx(t, { ...o, ref: l, children: i });
  });
  return n.displayName = `${e}.Slot`, n;
}
// @__NO_SIDE_EFFECTS__
function U2(e) {
  const t = v.forwardRef((n, a) => {
    const { children: l, ...i } = n;
    if (v.isValidElement(l)) {
      const o = H2(l), s = B2(i, l.props);
      return l.type !== v.Fragment && (s.ref = a ? ys(a, o) : o), v.cloneElement(l, s);
    }
    return v.Children.count(l) > 1 ? v.Children.only(null) : null;
  });
  return t.displayName = `${e}.SlotClone`, t;
}
var V2 = Symbol("radix.slottable");
function L2(e) {
  return v.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === V2;
}
function B2(e, t) {
  const n = { ...t };
  for (const a in t) {
    const l = e[a], i = t[a];
    /^on[A-Z]/.test(a) ? l && i ? n[a] = (...s) => {
      const c = i(...s);
      return l(...s), c;
    } : l && (n[a] = l) : a === "style" ? n[a] = { ...l, ...i } : a === "className" && (n[a] = [l, i].filter(Boolean).join(" "));
  }
  return { ...e, ...n };
}
function H2(e) {
  var a, l;
  let t = (a = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : a.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (l = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : l.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
function wv(e) {
  const t = e + "CollectionProvider", [n, a] = an(t), [l, i] = n(
    t,
    { collectionRef: { current: null }, itemMap: /* @__PURE__ */ new Map() }
  ), o = (x) => {
    const { scope: S, children: h } = x, d = xe.useRef(null), y = xe.useRef(/* @__PURE__ */ new Map()).current;
    return /* @__PURE__ */ r.jsx(l, { scope: S, itemMap: y, collectionRef: d, children: h });
  };
  o.displayName = t;
  const s = e + "CollectionSlot", c = /* @__PURE__ */ Ld(s), u = xe.forwardRef(
    (x, S) => {
      const { scope: h, children: d } = x, y = i(s, h), b = Ee(S, y.collectionRef);
      return /* @__PURE__ */ r.jsx(c, { ref: b, children: d });
    }
  );
  u.displayName = s;
  const m = e + "CollectionItemSlot", g = "data-radix-collection-item", f = /* @__PURE__ */ Ld(m), p = xe.forwardRef(
    (x, S) => {
      const { scope: h, children: d, ...y } = x, b = xe.useRef(null), N = Ee(S, b), O = i(m, h);
      return xe.useEffect(() => (O.itemMap.set(b, { ref: b, ...y }), () => void O.itemMap.delete(b))), /* @__PURE__ */ r.jsx(f, { [g]: "", ref: N, children: d });
    }
  );
  p.displayName = m;
  function C(x) {
    const S = i(e + "CollectionConsumer", x);
    return xe.useCallback(() => {
      const d = S.collectionRef.current;
      if (!d) return [];
      const y = Array.from(d.querySelectorAll(`[${g}]`));
      return Array.from(S.itemMap.values()).sort(
        (O, M) => y.indexOf(O.ref.current) - y.indexOf(M.ref.current)
      );
    }, [S.collectionRef, S.itemMap]);
  }
  return [
    { Provider: o, Slot: u, ItemSlot: p },
    C,
    a
  ];
}
var ll = globalThis != null && globalThis.document ? v.useLayoutEffect : () => {
}, G2 = wc[" useId ".trim().toString()] || (() => {
}), Y2 = 0;
function Av(e) {
  const [t, n] = v.useState(G2());
  return ll(() => {
    n((a) => a ?? String(Y2++));
  }, [e]), e || (t ? `radix-${t}` : "");
}
function bn(e) {
  const t = v.useRef(e);
  return v.useEffect(() => {
    t.current = e;
  }), v.useMemo(() => (...n) => {
    var a;
    return (a = t.current) == null ? void 0 : a.call(t, ...n);
  }, []);
}
var q2 = wc[" useInsertionEffect ".trim().toString()] || ll;
function qn({
  prop: e,
  defaultProp: t,
  onChange: n = () => {
  },
  caller: a
}) {
  const [l, i, o] = X2({
    defaultProp: t,
    onChange: n
  }), s = e !== void 0, c = s ? e : l;
  {
    const m = v.useRef(e !== void 0);
    v.useEffect(() => {
      const g = m.current;
      g !== s && console.warn(
        `${a} is changing from ${g ? "controlled" : "uncontrolled"} to ${s ? "controlled" : "uncontrolled"}. Components should not switch from controlled to uncontrolled (or vice versa). Decide between using a controlled or uncontrolled value for the lifetime of the component.`
      ), m.current = s;
    }, [s, a]);
  }
  const u = v.useCallback(
    (m) => {
      var g;
      if (s) {
        const f = Q2(m) ? m(e) : m;
        f !== e && ((g = o.current) == null || g.call(o, f));
      } else
        i(m);
    },
    [s, e, i, o]
  );
  return [c, u];
}
function X2({
  defaultProp: e,
  onChange: t
}) {
  const [n, a] = v.useState(e), l = v.useRef(n), i = v.useRef(t);
  return q2(() => {
    i.current = t;
  }, [t]), v.useEffect(() => {
    var o;
    l.current !== n && ((o = i.current) == null || o.call(i, n), l.current = n);
  }, [n, l]), [n, a, i];
}
function Q2(e) {
  return typeof e == "function";
}
var Z2 = v.createContext(void 0);
function vl(e) {
  const t = v.useContext(Z2);
  return e || t || "ltr";
}
var gr = "rovingFocusGroup.onEntryFocus", F2 = { bubbles: !1, cancelable: !0 }, Ai = "RovingFocusGroup", [hc, Nv, K2] = wv(Ai), [J2, pl] = an(
  Ai,
  [K2]
), [I2, W2] = J2(Ai), Ev = v.forwardRef(
  (e, t) => /* @__PURE__ */ r.jsx(hc.Provider, { scope: e.__scopeRovingFocusGroup, children: /* @__PURE__ */ r.jsx(hc.Slot, { scope: e.__scopeRovingFocusGroup, children: /* @__PURE__ */ r.jsx($2, { ...e, ref: t }) }) })
);
Ev.displayName = Ai;
var $2 = v.forwardRef((e, t) => {
  const {
    __scopeRovingFocusGroup: n,
    orientation: a,
    loop: l = !1,
    dir: i,
    currentTabStopId: o,
    defaultCurrentTabStopId: s,
    onCurrentTabStopIdChange: c,
    onEntryFocus: u,
    preventScrollOnEntryFocus: m = !1,
    ...g
  } = e, f = v.useRef(null), p = Ee(t, f), C = vl(i), [x, S] = qn({
    prop: o,
    defaultProp: s ?? null,
    onChange: c,
    caller: Ai
  }), [h, d] = v.useState(!1), y = bn(u), b = Nv(n), N = v.useRef(!1), [O, M] = v.useState(0);
  return v.useEffect(() => {
    const A = f.current;
    if (A)
      return A.addEventListener(gr, y), () => A.removeEventListener(gr, y);
  }, [y]), /* @__PURE__ */ r.jsx(
    I2,
    {
      scope: n,
      orientation: a,
      dir: C,
      loop: l,
      currentTabStopId: x,
      onItemFocus: v.useCallback(
        (A) => S(A),
        [S]
      ),
      onItemShiftTab: v.useCallback(() => d(!0), []),
      onFocusableItemAdd: v.useCallback(
        () => M((A) => A + 1),
        []
      ),
      onFocusableItemRemove: v.useCallback(
        () => M((A) => A - 1),
        []
      ),
      children: /* @__PURE__ */ r.jsx(
        me.div,
        {
          tabIndex: h || O === 0 ? -1 : 0,
          "data-orientation": a,
          ...g,
          ref: p,
          style: { outline: "none", ...e.style },
          onMouseDown: ue(e.onMouseDown, () => {
            N.current = !0;
          }),
          onFocus: ue(e.onFocus, (A) => {
            const w = !N.current;
            if (A.target === A.currentTarget && w && !h) {
              const E = new CustomEvent(gr, F2);
              if (A.currentTarget.dispatchEvent(E), !E.defaultPrevented) {
                const R = b().filter((j) => j.focusable), k = R.find((j) => j.active), V = R.find((j) => j.id === x), z = [k, V, ...R].filter(
                  Boolean
                ).map((j) => j.ref.current);
                Tv(z, m);
              }
            }
            N.current = !1;
          }),
          onBlur: ue(e.onBlur, () => d(!1))
        }
      )
    }
  );
}), jv = "RovingFocusGroupItem", Mv = v.forwardRef(
  (e, t) => {
    const {
      __scopeRovingFocusGroup: n,
      focusable: a = !0,
      active: l = !1,
      tabStopId: i,
      children: o,
      ...s
    } = e, c = Av(), u = i || c, m = W2(jv, n), g = m.currentTabStopId === u, f = Nv(n), { onFocusableItemAdd: p, onFocusableItemRemove: C, currentTabStopId: x } = m;
    return v.useEffect(() => {
      if (a)
        return p(), () => C();
    }, [a, p, C]), /* @__PURE__ */ r.jsx(
      hc.ItemSlot,
      {
        scope: n,
        id: u,
        focusable: a,
        active: l,
        children: /* @__PURE__ */ r.jsx(
          me.span,
          {
            tabIndex: g ? 0 : -1,
            "data-orientation": m.orientation,
            ...s,
            ref: t,
            onMouseDown: ue(e.onMouseDown, (S) => {
              a ? m.onItemFocus(u) : S.preventDefault();
            }),
            onFocus: ue(e.onFocus, () => m.onItemFocus(u)),
            onKeyDown: ue(e.onKeyDown, (S) => {
              if (S.key === "Tab" && S.shiftKey) {
                m.onItemShiftTab();
                return;
              }
              if (S.target !== S.currentTarget) return;
              const h = tC(S, m.orientation, m.dir);
              if (h !== void 0) {
                if (S.metaKey || S.ctrlKey || S.altKey || S.shiftKey) return;
                S.preventDefault();
                let y = f().filter((b) => b.focusable).map((b) => b.ref.current);
                if (h === "last") y.reverse();
                else if (h === "prev" || h === "next") {
                  h === "prev" && y.reverse();
                  const b = y.indexOf(S.currentTarget);
                  y = m.loop ? nC(y, b + 1) : y.slice(b + 1);
                }
                setTimeout(() => Tv(y));
              }
            }),
            children: typeof o == "function" ? o({ isCurrentTabStop: g, hasTabStop: x != null }) : o
          }
        )
      }
    );
  }
);
Mv.displayName = jv;
var P2 = {
  ArrowLeft: "prev",
  ArrowUp: "prev",
  ArrowRight: "next",
  ArrowDown: "next",
  PageUp: "first",
  Home: "first",
  PageDown: "last",
  End: "last"
};
function eC(e, t) {
  return t !== "rtl" ? e : e === "ArrowLeft" ? "ArrowRight" : e === "ArrowRight" ? "ArrowLeft" : e;
}
function tC(e, t, n) {
  const a = eC(e.key, n);
  if (!(t === "vertical" && ["ArrowLeft", "ArrowRight"].includes(a)) && !(t === "horizontal" && ["ArrowUp", "ArrowDown"].includes(a)))
    return P2[a];
}
function Tv(e, t = !1) {
  const n = document.activeElement;
  for (const a of e)
    if (a === n || (a.focus({ preventScroll: t }), document.activeElement !== n)) return;
}
function nC(e, t) {
  return e.map((n, a) => e[(t + a) % e.length]);
}
var Nu = Ev, Eu = Mv, Dv = "Toggle", _v = v.forwardRef((e, t) => {
  const { pressed: n, defaultPressed: a, onPressedChange: l, ...i } = e, [o, s] = qn({
    prop: n,
    onChange: l,
    defaultProp: a ?? !1,
    caller: Dv
  });
  return /* @__PURE__ */ r.jsx(
    me.button,
    {
      type: "button",
      "aria-pressed": o,
      "data-state": o ? "on" : "off",
      "data-disabled": e.disabled ? "" : void 0,
      ...i,
      ref: t,
      onClick: ue(e.onClick, () => {
        e.disabled || s(!o);
      })
    }
  );
});
_v.displayName = Dv;
var Xn = "ToggleGroup", [Ov] = an(Xn, [
  pl
]), zv = pl(), ju = xe.forwardRef((e, t) => {
  const { type: n, ...a } = e;
  if (n === "single") {
    const l = a;
    return /* @__PURE__ */ r.jsx(aC, { ...l, ref: t });
  }
  if (n === "multiple") {
    const l = a;
    return /* @__PURE__ */ r.jsx(lC, { ...l, ref: t });
  }
  throw new Error(`Missing prop \`type\` expected on \`${Xn}\``);
});
ju.displayName = Xn;
var [Rv, kv] = Ov(Xn), aC = xe.forwardRef((e, t) => {
  const {
    value: n,
    defaultValue: a,
    onValueChange: l = () => {
    },
    ...i
  } = e, [o, s] = qn({
    prop: n,
    defaultProp: a ?? "",
    onChange: l,
    caller: Xn
  });
  return /* @__PURE__ */ r.jsx(
    Rv,
    {
      scope: e.__scopeToggleGroup,
      type: "single",
      value: xe.useMemo(() => o ? [o] : [], [o]),
      onItemActivate: s,
      onItemDeactivate: xe.useCallback(() => s(""), [s]),
      children: /* @__PURE__ */ r.jsx(Uv, { ...i, ref: t })
    }
  );
}), lC = xe.forwardRef((e, t) => {
  const {
    value: n,
    defaultValue: a,
    onValueChange: l = () => {
    },
    ...i
  } = e, [o, s] = qn({
    prop: n,
    defaultProp: a ?? [],
    onChange: l,
    caller: Xn
  }), c = xe.useCallback(
    (m) => s((g = []) => [...g, m]),
    [s]
  ), u = xe.useCallback(
    (m) => s((g = []) => g.filter((f) => f !== m)),
    [s]
  );
  return /* @__PURE__ */ r.jsx(
    Rv,
    {
      scope: e.__scopeToggleGroup,
      type: "multiple",
      value: o,
      onItemActivate: c,
      onItemDeactivate: u,
      children: /* @__PURE__ */ r.jsx(Uv, { ...i, ref: t })
    }
  );
});
ju.displayName = Xn;
var [iC, oC] = Ov(Xn), Uv = xe.forwardRef(
  (e, t) => {
    const {
      __scopeToggleGroup: n,
      disabled: a = !1,
      rovingFocus: l = !0,
      orientation: i,
      dir: o,
      loop: s = !0,
      ...c
    } = e, u = zv(n), m = vl(o), g = { role: "group", dir: m, ...c };
    return /* @__PURE__ */ r.jsx(iC, { scope: n, rovingFocus: l, disabled: a, children: l ? /* @__PURE__ */ r.jsx(
      Nu,
      {
        asChild: !0,
        ...u,
        orientation: i,
        dir: m,
        loop: s,
        children: /* @__PURE__ */ r.jsx(me.div, { ...g, ref: t })
      }
    ) : /* @__PURE__ */ r.jsx(me.div, { ...g, ref: t }) });
  }
), Jo = "ToggleGroupItem", Vv = xe.forwardRef(
  (e, t) => {
    const n = kv(Jo, e.__scopeToggleGroup), a = oC(Jo, e.__scopeToggleGroup), l = zv(e.__scopeToggleGroup), i = n.value.includes(e.value), o = a.disabled || e.disabled, s = { ...e, pressed: i, disabled: o }, c = xe.useRef(null);
    return a.rovingFocus ? /* @__PURE__ */ r.jsx(
      Eu,
      {
        asChild: !0,
        ...l,
        focusable: !o,
        active: i,
        ref: c,
        children: /* @__PURE__ */ r.jsx(Bd, { ...s, ref: t })
      }
    ) : /* @__PURE__ */ r.jsx(Bd, { ...s, ref: t });
  }
);
Vv.displayName = Jo;
var Bd = xe.forwardRef(
  (e, t) => {
    const { __scopeToggleGroup: n, value: a, ...l } = e, i = kv(Jo, n), o = { role: "radio", "aria-checked": e.pressed, "aria-pressed": void 0 }, s = i.type === "single" ? o : void 0;
    return /* @__PURE__ */ r.jsx(
      _v,
      {
        ...s,
        ...l,
        ref: t,
        onPressedChange: (c) => {
          c ? i.onItemActivate(a) : i.onItemDeactivate(a);
        }
      }
    );
  }
), sC = ju, rC = Vv;
const cC = Cv(
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
), Lv = v.createContext({
  size: "default",
  variant: "default"
});
function Bv({
  className: e,
  variant: t,
  size: n,
  children: a,
  ...l
}) {
  return /* @__PURE__ */ r.jsx(
    sC,
    {
      "data-slot": "toggle-group",
      "data-variant": t,
      "data-size": n,
      className: te(
        "group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs",
        e
      ),
      ...l,
      children: /* @__PURE__ */ r.jsx(Lv.Provider, { value: { variant: t, size: n }, children: a })
    }
  );
}
function $n({
  className: e,
  children: t,
  variant: n,
  size: a,
  ...l
}) {
  const i = v.useContext(Lv);
  return /* @__PURE__ */ r.jsx(
    rC,
    {
      "data-slot": "toggle-group-item",
      "data-variant": i.variant || n,
      "data-size": i.size || a,
      className: te(
        cC({
          variant: i.variant || n,
          size: i.size || a
        }),
        "min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus:z-10 focus-visible:z-10 data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l",
        e
      ),
      ...l,
      children: t
    }
  );
}
const uC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABmJLR0QAMQBwAP8c8a2UAAAACXBIWXMAAA9hAAAPYQGoP6dpAAAAB3RJTUUH4AEUExQQFfKCQgAAACZpVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVAgb24gYSBNYWOV5F9bAAACcElEQVRIx5XWT4hXVRQH8M9vxmlKzE2CVqJiMgUzGUoLQQXN1iqI5EJQGUJIRURBDF20aSMRJFGgtGjhwkWUiEkKuhBSzDaJCFI0VCr4Lx3UmhF/br5P7jzm93N+Fx73vXPPPd97zv2ec163iY0GJmVuoEsHG1vJm3l/DWuxHI8xhJm4gB9wVYejAu3G+7gTsNu4i0eFrIldeKETgO7MG2JgFIewEIvwHt7FTvwRnc8maryK7QCuYxgftgnlW/g5IKs68eJgNm0uZC+iJx72YnLki3OQv/HKRGK/IsZP4+Vx9CYV71Xs92fPYBtvn41dUV5TyObiK/Tn+2NsLdb78RcuxtOWINPwYwCWFvIvw55/cTTrlzC/0Pk18uklQD1hXg3fv8tpKsWrATgQ6n6OKSFCNc5kXh6gxngAs3OBV/CwoOw/ife+nPoObuFmLh7OJRGXlHdaBxjI/EstJ/pxGa8nP07hDcxInnThBG5gdRmdOsDDFqHbiJ+wHutwLSdclvUe3I8HjfESqxovZR7J/D/2xMBxfBLqDuIbfBQbo0VY/msHUHH8cSHblqJ2JF58GoqOhDFL8aRFnoz9wO+Z5xWys4n7b/ggbOrDbpyvMalZXPq4WbwgSkcxNbJZAZhR6E8Jo8pkXIkH+L5GkDGjp6hDa1scpJ6lVbk4ln2LW/WaSrAE9+L6rMJIV/E0csKq4G2K8ZNF52tb8PYW5aCvIESjBihl+nr03+mkhX6dTcPYkTt4s0jGOTic3GkV0ud2tS0BaNaekVCziT9Tnzpq+tWFj6bBb8fb6cm94f4QvsC3RQifdPoD0D2BX5SedjpPAbRYi2qFhp13AAAAAElFTkSuQmCC", fC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA9hAAAPYQGoP6dpAAAAB3RJTUUH4AEUEzUtwQXbsAAAACZpVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVAgb24gYSBNYWOV5F9bAAAB9klEQVRIx8WWP2gUQRTGf7u3yRGJKInkOAlXnNZaiE0Kg6nOQAohtWhrmjQemICCkM7SXkFBThBLlYCkC0JIUihnEbETD5EkFzn1ksvafAPPcY/duxQZWIaZeX++9733ZhaOeYRHPE8VGAauAh+B78BF4CHwFXgJjPWLPADuA3GG75PkM488sCPlA6AJzAMPjNELwKpZd4DxNEYcihj4o7niyUSebBFoGPnJNPQN4BD4oXUuAYSlY0DzsommbID8o3hOlMTACWCwh3wBrAP7wJtugksy/jhBmYyJdFEkjk2PxxAYAT4DH7yIHonOCS+xTdkYTUq4Oyyaw23gNbAB1LXnyncpAW1DeyWXP+vlpOa2Di8Dp4FrwFMjd0ZOF7WeMfT91FywlAZy5Pg7pSp4IsMVleE9yZcl9w54DryVfqCmi4HrpsIIhd45GBLfd83eTY+KEvDK5CwQqPdi4LYa9r8GcxG4+j+vko26NJwD6NB+kY3ZpDJfUZNtATeEYCCl/R24KaBqQOZ9vVDIDyXQMglLGzXR0pFuLU1hLq1hvPFNsi+A6aw36q4Q1RW+5T004V8yYK5kNZ4DFqT0W/Me8Eznt1SOv7ybl17fhbJKtWVQOodts1ft91WLDBUTHto7wNkuV3jfzgrAmu6gTA9+v38YUS9KfwHiN479kenpigAAAABJRU5ErkJggg==", dC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA9hAAAPYQGoP6dpAAAAB3RJTUUH4AEUExsoumgmEwAAACZpVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVAgb24gYSBNYWOV5F9bAAACHUlEQVRIx+XVy4tOYRwH8M+M4R0iWcnrkgYxZTkimRIWppRSaLCxIAvFxj/AjFtsWFlQFBvCgrAQBuU2WbmMYWbIbWdqZsiMvDa/U09vx8zbTFaeenrOOb/v7/J8f5fDP15VFcpTXKnsHPUaV4Hz6tHeYAIGMQsbMAef8Ru9uIUvgS1gKGQVrdo49+NjUJHuAbzDc6xM9MZXYjwD3cavMHgVu3EXp/EtcfYdnVhWCa0ZXZdC+RNW5+AKaMCxoGso8DcwbSTjeyPyXiyIb5NGSOYRvAwnjzH9b8D56ApgU1k+YB1acAit2JbI6/A6dJ9hap6DAwE4VZaP+oisC5dxAReD+05sCdxC3AwbrZGPqjT6AfTHc7amRMLPYnZOUDtC72i8L43yLWFGSu3O+HiwzMBctKMRRVzH+8C+wSIsL+uBEyFvhprYDSG8X+agBw9wDRNxBifxFZvxNMr2YaLzNs7FmQNJBHnVsgfn8QF9OBy36cDa4Lotwc+Mszs1sj2udS+nlrPmKSblWEqacGOMk+Yo2e6Q1aVJnhw0lHA8blYdgEJg9oW8HSvwKGeMZLsl088o6o/SasSqABXwI+RLsCaa8EXkZRPWR7UUQ3YnHPfkDb8inoTxrUkDdcS3QfzEvGHyNeIc2hVRl8LwuXh+FQ1WX4avjhxle1inNUnztAVtpZz+qBrLX6wmGXBNMVmvRA7GbFwOt7Xxd/uP1x8qjZQl/fBreAAAAABJRU5ErkJggg==";
function mC({ currentView: e, onViewChange: t }) {
  return /* @__PURE__ */ r.jsx("div", { className: "flex items-center", children: /* @__PURE__ */ r.jsxs(
    Bv,
    {
      type: "single",
      value: e,
      onValueChange: (n) => n && t(n),
      children: [
        /* @__PURE__ */ r.jsxs($n, { value: "axial", "aria-label": "Axial view", title: "Axial view", children: [
          /* @__PURE__ */ r.jsx("img", { src: uC, alt: "axial", className: "dark:invert" }),
          /* @__PURE__ */ r.jsx("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "Axial" })
        ] }),
        /* @__PURE__ */ r.jsxs($n, { value: "coronal", "aria-label": "Coronal view", title: "Coronal view", children: [
          /* @__PURE__ */ r.jsx("img", { src: fC, alt: "coronal", className: "dark:invert" }),
          /* @__PURE__ */ r.jsx("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "Coronal" })
        ] }),
        /* @__PURE__ */ r.jsxs($n, { value: "sagittal", "aria-label": "Sagittal view", title: "Sagittal view", children: [
          /* @__PURE__ */ r.jsx("img", { src: dC, alt: "sagittal", className: "dark:invert" }),
          /* @__PURE__ */ r.jsx("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "Sagittal" })
        ] }),
        /* @__PURE__ */ r.jsxs($n, { value: "render", "aria-label": "Render view", title: "Render view", children: [
          /* @__PURE__ */ r.jsx(pv, { className: "h-4 w-4 mr-1" }),
          /* @__PURE__ */ r.jsx("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "Render" })
        ] }),
        /* @__PURE__ */ r.jsxs($n, { value: "ACS", "aria-label": "Multi view", title: "Multi view", children: [
          /* @__PURE__ */ r.jsx(xS, { className: "h-4 w-4 mr-1" }),
          /* @__PURE__ */ r.jsx("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "ACS" })
        ] }),
        /* @__PURE__ */ r.jsxs($n, { value: "ACSR", "aria-label": "Multi+Render", title: "Multi+Render", children: [
          /* @__PURE__ */ r.jsx(RS, { className: "h-4 w-4 mr-1" }),
          /* @__PURE__ */ r.jsx("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: "ACSR" })
        ] })
      ]
    }
  ) });
}
const hC = {
  none: { icon: XS, label: "None", displayName: "none" },
  contrast: { icon: Od, label: "Contrast", displayName: "contrast" },
  measurement: { icon: n2, label: "Measurement", displayName: "measurement" },
  pan: { icon: Rd, label: "Pan/Zoom", displayName: "pan/zoom" },
  slicer3D: { icon: HS, label: "Slicer 3D", displayName: "slicer3D" },
  callbackOnly: { icon: vS, label: "Callback Only", displayName: "callbackOnly" },
  roiSelection: { icon: f2, label: "ROI Selection", displayName: "roiSelection" },
  angle: { icon: zd, label: "Angle", displayName: "angle" },
  crosshair: { icon: zd, label: "Crosshair", displayName: "crosshair" },
  windowing: { icon: Od, label: "Windowing", displayName: "windowing" },
  // rc.16: a click places the crosshair, a drag past a small threshold pans.
  crosshairPan: { icon: Rd, label: "Crosshair + Pan", displayName: "crosshair/pan" }
}, gC = Object.keys(fo).filter(
  (e) => isNaN(Number(e))
);
function vC({
  currentMode: e,
  onModeChange: t,
  availableModes: n = gC
}) {
  return /* @__PURE__ */ r.jsx("div", { className: "flex items-center", children: /* @__PURE__ */ r.jsx(
    Bv,
    {
      type: "single",
      value: e,
      onValueChange: (a) => a && t(a),
      children: n.map((a) => {
        const l = hC[a], i = l.icon;
        return /* @__PURE__ */ r.jsxs(
          $n,
          {
            value: a,
            "aria-label": l.label,
            title: l.label,
            children: [
              /* @__PURE__ */ r.jsx(i, { className: "h-4 w-4 mr-1" }),
              /* @__PURE__ */ r.jsx("span", { className: "sr-only sm:not-sr-only sm:inline-block text-xs", children: l.displayName })
            ]
          },
          a
        );
      })
    }
  ) });
}
function pC({ nvRef: e }) {
  const t = T((f) => f.sidebarOpen), n = T((f) => f.setSidebarOpen), a = T((f) => f.footerOpen), l = T((f) => f.setFooterOpen), i = T((f) => f.darkMode), o = T((f) => f.setDarkMode), s = T(
    (f) => f.setSettingsDialogOpen
  ), {
    viewerOptions: c,
    handleViewMode: u,
    handleDragModeChange: m,
    resetViewAndContrast: g
  } = xu(e);
  return /* @__PURE__ */ r.jsx("header", { className: "border-b bg-background px-6 py-3", children: /* @__PURE__ */ r.jsxs("div", { className: "flex items-center justify-between", children: [
    /* @__PURE__ */ r.jsxs("h1", { className: "text-xl font-semibold flex items-center", children: [
      /* @__PURE__ */ r.jsx(ps, { className: "h-6 w-6 mr-2" }),
      /* @__PURE__ */ r.jsxs(
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
    /* @__PURE__ */ r.jsx("div", { className: "bg-background p-2", children: /* @__PURE__ */ r.jsxs("div", { className: "flex items-center justify-between flex-wrap gap-4", children: [
      /* @__PURE__ */ r.jsxs("div", { className: "flex items-center gap-2 border border-border rounded-md px-3 py-1", children: [
        /* @__PURE__ */ r.jsx("span", { className: "text-sm font-medium", children: "View:" }),
        /* @__PURE__ */ r.jsx(
          mC,
          {
            currentView: c.viewMode,
            onViewChange: u
          }
        )
      ] }),
      /* @__PURE__ */ r.jsxs("div", { className: "flex items-center gap-2 border border-border rounded-md px-3 py-1", children: [
        /* @__PURE__ */ r.jsx("span", { className: "text-sm font-medium", children: "Right drag:" }),
        /* @__PURE__ */ r.jsx(
          vC,
          {
            currentMode: c.dragMode,
            onModeChange: m,
            availableModes: ["contrast", "pan"]
          }
        )
      ] })
    ] }) }),
    /* @__PURE__ */ r.jsxs("div", { className: "flex items-center gap-2", children: [
      /* @__PURE__ */ r.jsx(
        q,
        {
          variant: "outline",
          size: "sm",
          onClick: g,
          className: "h-8 w-8 p-0",
          title: "Reset view+contrast of all volumes",
          children: /* @__PURE__ */ r.jsx(e2, { className: "h-4 w-4" })
        }
      ),
      /* @__PURE__ */ r.jsx(
        q,
        {
          variant: "outline",
          size: "sm",
          onClick: () => n(!t),
          className: "h-8 w-8 p-0",
          title: t ? "Hide sidebar" : "Show sidebar",
          children: t ? /* @__PURE__ */ r.jsx(WS, { className: "h-4 w-4" }) : /* @__PURE__ */ r.jsx(JS, { className: "h-4 w-4" })
        }
      ),
      /* @__PURE__ */ r.jsx(
        q,
        {
          variant: "outline",
          size: "sm",
          onClick: () => l(!a),
          className: "h-8 w-8 p-0",
          title: a ? "Hide footer" : "Show footer",
          children: /* @__PURE__ */ r.jsx(
            FS,
            {
              className: te("h-4 w-4", !a && "rotate-180")
            }
          )
        }
      ),
      /* @__PURE__ */ r.jsx(
        q,
        {
          variant: "outline",
          size: "sm",
          onClick: () => o(!i),
          className: "h-8 w-8 p-0",
          title: i ? "Switch to light mode" : "Switch to dark mode",
          children: i ? /* @__PURE__ */ r.jsx(m2, { className: "h-4 w-4" }) : /* @__PURE__ */ r.jsx(YS, { className: "h-4 w-4" })
        }
      ),
      /* @__PURE__ */ r.jsx(
        q,
        {
          variant: "outline",
          size: "sm",
          onClick: () => s(!0),
          className: "h-8 w-8 p-0",
          title: "Settings",
          children: /* @__PURE__ */ r.jsx(i2, { className: "h-4 w-4" })
        }
      )
    ] })
  ] }) });
}
function yC() {
  const e = T((t) => t.locationData);
  return /* @__PURE__ */ r.jsx("footer", { className: "border-t bg-background px-4 py-4 flex-shrink-0", children: e ? /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
    /* @__PURE__ */ r.jsxs("div", { className: "grid grid-cols-[50%_auto_1fr] gap-4 items-center text-sm", children: [
      /* @__PURE__ */ r.jsx("div", {}),
      /* @__PURE__ */ r.jsxs("div", { className: "text-muted-foreground font-mono whitespace-nowrap", children: [
        /* @__PURE__ */ r.jsx("span", { className: "inline-block w-16", children: "RAS" }),
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
      /* @__PURE__ */ r.jsx("div", {})
    ] }),
    e.voxels.map((t, n) => /* @__PURE__ */ r.jsxs(
      "div",
      {
        className: te(
          "grid grid-cols-[50%_auto_1fr] gap-4 items-center text-sm px-2 py-1 rounded-sm",
          n % 2 === 1 && "bg-accent"
        ),
        children: [
          /* @__PURE__ */ r.jsxs("div", { className: "font-medium overflow-x-auto whitespace-nowrap", children: [
            t.name,
            ":"
          ] }),
          /* @__PURE__ */ r.jsxs("div", { className: "text-muted-foreground font-mono whitespace-nowrap", children: [
            /* @__PURE__ */ r.jsx("span", { className: "inline-block w-16", children: "Voxel" }),
            "[",
            t.voxel[0],
            ", ",
            t.voxel[1],
            ", ",
            t.voxel[2],
            "]"
          ] }),
          /* @__PURE__ */ r.jsxs("div", { className: "text-muted-foreground", children: [
            "Value: ",
            t.value.toFixed(2)
          ] })
        ]
      },
      n
    ))
  ] }) : /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground", children: "Load images to see coordinates" }) });
}
function bC({ onUpload: e, compact: t = !1 }) {
  const [n, a] = v.useState(!1), l = v.useRef(null), i = (m) => {
    m.preventDefault(), a(!0);
  }, o = () => {
    a(!1);
  }, s = (m) => {
    if (m.preventDefault(), a(!1), m.dataTransfer.files && m.dataTransfer.files.length > 0) {
      const g = Array.from(m.dataTransfer.files);
      e(g);
    }
  }, c = (m) => {
    if (m.target.files && m.target.files.length > 0) {
      console.log("Files selected:", m.target.files);
      const g = Array.from(m.target.files);
      e(g);
    }
  }, u = () => {
    var m;
    (m = l.current) == null || m.click();
  };
  return t ? /* @__PURE__ */ r.jsxs("div", { className: "w-full", children: [
    /* @__PURE__ */ r.jsxs(q, { variant: "outline", className: "w-full", onClick: u, children: [
      /* @__PURE__ */ r.jsx(fi, { className: "mr-2 h-4 w-4" }),
      "Upload Images"
    ] }),
    /* @__PURE__ */ r.jsx(
      "input",
      {
        type: "file",
        ref: l,
        onChange: c,
        accept: "image/*",
        multiple: !0,
        className: "hidden"
      }
    )
  ] }) : /* @__PURE__ */ r.jsx(
    "div",
    {
      className: te(
        "border-2 border-dashed rounded-lg p-12 text-center transition-colors",
        n ? "border-primary bg-primary/5" : "border-muted-foreground/25",
        "max-w-xl mx-auto w-full"
      ),
      onDragOver: i,
      onDragLeave: o,
      onDrop: s,
      children: /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col items-center justify-center gap-4", children: [
        /* @__PURE__ */ r.jsx("div", { className: "rounded-full bg-background p-3 shadow-sm", children: /* @__PURE__ */ r.jsx(OS, { className: "h-10 w-10 text-muted-foreground" }) }),
        /* @__PURE__ */ r.jsxs("div", { className: "grid gap-1 text-center", children: [
          /* @__PURE__ */ r.jsx("h3", { className: "text-lg font-semibold", children: "Load Medical Images" }),
          /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground", children: "Drag and drop your medical images here or click to browse" }),
          /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground", children: "No data will leave your device by loading data" })
        ] }),
        /* @__PURE__ */ r.jsxs(q, { onClick: u, children: [
          /* @__PURE__ */ r.jsx(fi, { className: "mr-2 h-4 w-4" }),
          "Select Files"
        ] }),
        /* @__PURE__ */ r.jsx(
          "input",
          {
            type: "file",
            ref: l,
            onChange: c,
            multiple: !0,
            className: "hidden"
          }
        )
      ] })
    }
  );
}
function xC({ viewMode: e, nvRef: t }) {
  const n = v.useRef(null), a = v.useRef(null), [l, i] = v.useState(!1);
  v.useEffect(() => {
    const c = n.current, u = t;
    console.log("NiiVue attached to canvas", u), c && u && (u.attachToCanvas(c), i(!0));
  }, []);
  const o = () => null, s = () => e === "ACSR" || e === "ACS" ? null : /* @__PURE__ */ r.jsxs("div", { className: "absolute top-2 left-2 bg-black/50 text-white px-2 py-1 rounded text-xs font-medium", children: [
    e.charAt(0).toUpperCase() + e.slice(1),
    " View"
  ] });
  return /* @__PURE__ */ r.jsxs(
    "div",
    {
      ref: a,
      className: "niivue-canvas w-full h-full relative bg-[#111]",
      children: [
        /* @__PURE__ */ r.jsx("canvas", { ref: n }),
        s(),
        o(),
        !l && /* @__PURE__ */ r.jsx("div", { className: "absolute inset-0 flex items-center justify-center text-white", children: "Loading image..." })
      ]
    }
  );
}
function SC({
  nvInstance: e,
  viewMode: t,
  onFileUpload: n,
  nvCanvasEmptyState: a
}) {
  const l = T((i) => i.showUploader);
  return /* @__PURE__ */ r.jsx("main", { className: "flex-1 min-h-0 overflow-hidden flex flex-col", children: l ? /* @__PURE__ */ r.jsx("div", { className: "flex flex-1 items-center justify-center", children: a ?? /* @__PURE__ */ r.jsx(bC, { onUpload: n }) }) : /* @__PURE__ */ r.jsx("div", { className: "flex flex-1", children: /* @__PURE__ */ r.jsx(xC, { viewMode: t, nvRef: e }) }) });
}
function CC({
  nvInstance: e,
  viewMode: t,
  onFileUpload: n,
  sidebar: a,
  dialogs: l,
  hiddenInputs: i,
  nvCanvasEmptyState: o
}) {
  const s = T((g) => g.sidebarOpen), c = T((g) => g.footerOpen), u = T((g) => g.darkMode), m = v.useRef(e);
  return m.current = e, /* @__PURE__ */ r.jsxs(
    "div",
    {
      className: te(
        "freebrowse-root relative flex h-full flex-col",
        u && "dark"
      ),
      children: [
        /* @__PURE__ */ r.jsx(pC, { nvRef: m }),
        /* @__PURE__ */ r.jsxs("div", { className: "flex flex-1 overflow-hidden", children: [
          /* @__PURE__ */ r.jsxs("div", { className: "flex flex-1 flex-col min-h-0", children: [
            /* @__PURE__ */ r.jsx(
              SC,
              {
                nvInstance: e,
                viewMode: t,
                onFileUpload: n,
                nvCanvasEmptyState: o
              }
            ),
            c && /* @__PURE__ */ r.jsx(yC, {})
          ] }),
          s && a
        ] }),
        i,
        l
      ]
    }
  );
}
function wC(e, t) {
  return v.useReducer((n, a) => t[n][a] ?? n, e);
}
var Qn = (e) => {
  const { present: t, children: n } = e, a = AC(t), l = typeof n == "function" ? n({ present: a.isPresent }) : v.Children.only(n), i = Ee(a.ref, NC(l));
  return typeof n == "function" || a.isPresent ? v.cloneElement(l, { ref: i }) : null;
};
Qn.displayName = "Presence";
function AC(e) {
  const [t, n] = v.useState(), a = v.useRef(null), l = v.useRef(e), i = v.useRef("none"), o = e ? "mounted" : "unmounted", [s, c] = wC(o, {
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
  return v.useEffect(() => {
    const u = Ki(a.current);
    i.current = s === "mounted" ? u : "none";
  }, [s]), ll(() => {
    const u = a.current, m = l.current;
    if (m !== e) {
      const f = i.current, p = Ki(u);
      e ? c("MOUNT") : p === "none" || (u == null ? void 0 : u.display) === "none" ? c("UNMOUNT") : c(m && f !== p ? "ANIMATION_OUT" : "UNMOUNT"), l.current = e;
    }
  }, [e, c]), ll(() => {
    if (t) {
      let u;
      const m = t.ownerDocument.defaultView ?? window, g = (p) => {
        const x = Ki(a.current).includes(CSS.escape(p.animationName));
        if (p.target === t && x && (c("ANIMATION_END"), !l.current)) {
          const S = t.style.animationFillMode;
          t.style.animationFillMode = "forwards", u = m.setTimeout(() => {
            t.style.animationFillMode === "forwards" && (t.style.animationFillMode = S);
          });
        }
      }, f = (p) => {
        p.target === t && (i.current = Ki(a.current));
      };
      return t.addEventListener("animationstart", f), t.addEventListener("animationcancel", g), t.addEventListener("animationend", g), () => {
        m.clearTimeout(u), t.removeEventListener("animationstart", f), t.removeEventListener("animationcancel", g), t.removeEventListener("animationend", g);
      };
    } else
      c("ANIMATION_END");
  }, [t, c]), {
    isPresent: ["mounted", "unmountSuspended"].includes(s),
    ref: v.useCallback((u) => {
      a.current = u ? getComputedStyle(u) : null, n(u);
    }, [])
  };
}
function Ki(e) {
  return (e == null ? void 0 : e.animationName) || "none";
}
function NC(e) {
  var a, l;
  let t = (a = Object.getOwnPropertyDescriptor(e.props, "ref")) == null ? void 0 : a.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = (l = Object.getOwnPropertyDescriptor(e, "ref")) == null ? void 0 : l.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
var bs = "Tabs", [EC] = an(bs, [
  pl
]), Hv = pl(), [jC, Mu] = EC(bs), Gv = v.forwardRef(
  (e, t) => {
    const {
      __scopeTabs: n,
      value: a,
      onValueChange: l,
      defaultValue: i,
      orientation: o = "horizontal",
      dir: s,
      activationMode: c = "automatic",
      ...u
    } = e, m = vl(s), [g, f] = qn({
      prop: a,
      onChange: l,
      defaultProp: i ?? "",
      caller: bs
    });
    return /* @__PURE__ */ r.jsx(
      jC,
      {
        scope: n,
        baseId: Av(),
        value: g,
        onValueChange: f,
        orientation: o,
        dir: m,
        activationMode: c,
        children: /* @__PURE__ */ r.jsx(
          me.div,
          {
            dir: m,
            "data-orientation": o,
            ...u,
            ref: t
          }
        )
      }
    );
  }
);
Gv.displayName = bs;
var Yv = "TabsList", qv = v.forwardRef(
  (e, t) => {
    const { __scopeTabs: n, loop: a = !0, ...l } = e, i = Mu(Yv, n), o = Hv(n);
    return /* @__PURE__ */ r.jsx(
      Nu,
      {
        asChild: !0,
        ...o,
        orientation: i.orientation,
        dir: i.dir,
        loop: a,
        children: /* @__PURE__ */ r.jsx(
          me.div,
          {
            role: "tablist",
            "aria-orientation": i.orientation,
            ...l,
            ref: t
          }
        )
      }
    );
  }
);
qv.displayName = Yv;
var Xv = "TabsTrigger", Qv = v.forwardRef(
  (e, t) => {
    const { __scopeTabs: n, value: a, disabled: l = !1, ...i } = e, o = Mu(Xv, n), s = Hv(n), c = Kv(o.baseId, a), u = Jv(o.baseId, a), m = a === o.value;
    return /* @__PURE__ */ r.jsx(
      Eu,
      {
        asChild: !0,
        ...s,
        focusable: !l,
        active: m,
        children: /* @__PURE__ */ r.jsx(
          me.button,
          {
            type: "button",
            role: "tab",
            "aria-selected": m,
            "aria-controls": u,
            "data-state": m ? "active" : "inactive",
            "data-disabled": l ? "" : void 0,
            disabled: l,
            id: c,
            ...i,
            ref: t,
            onMouseDown: ue(e.onMouseDown, (g) => {
              !l && g.button === 0 && g.ctrlKey === !1 ? o.onValueChange(a) : g.preventDefault();
            }),
            onKeyDown: ue(e.onKeyDown, (g) => {
              [" ", "Enter"].includes(g.key) && o.onValueChange(a);
            }),
            onFocus: ue(e.onFocus, () => {
              const g = o.activationMode !== "manual";
              !m && !l && g && o.onValueChange(a);
            })
          }
        )
      }
    );
  }
);
Qv.displayName = Xv;
var Zv = "TabsContent", Fv = v.forwardRef(
  (e, t) => {
    const { __scopeTabs: n, value: a, forceMount: l, children: i, ...o } = e, s = Mu(Zv, n), c = Kv(s.baseId, a), u = Jv(s.baseId, a), m = a === s.value, g = v.useRef(m);
    return v.useEffect(() => {
      const f = requestAnimationFrame(() => g.current = !1);
      return () => cancelAnimationFrame(f);
    }, []), /* @__PURE__ */ r.jsx(Qn, { present: l || m, children: ({ present: f }) => /* @__PURE__ */ r.jsx(
      me.div,
      {
        "data-state": m ? "active" : "inactive",
        "data-orientation": s.orientation,
        role: "tabpanel",
        "aria-labelledby": c,
        hidden: !f,
        id: u,
        tabIndex: 0,
        ...o,
        ref: t,
        style: {
          ...e.style,
          animationDuration: g.current ? "0s" : void 0
        },
        children: f && i
      }
    ) });
  }
);
Fv.displayName = Zv;
function Kv(e, t) {
  return `${e}-trigger-${t}`;
}
function Jv(e, t) {
  return `${e}-content-${t}`;
}
var MC = Gv, TC = qv, DC = Qv, _C = Fv;
function OC({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ r.jsx(
    MC,
    {
      "data-slot": "tabs",
      className: te("flex flex-col gap-2", e),
      ...t
    }
  );
}
function zC({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ r.jsx(
    TC,
    {
      "data-slot": "tabs-list",
      className: te(
        "bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]",
        e
      ),
      ...t
    }
  );
}
function xa({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ r.jsx(
    DC,
    {
      "data-slot": "tabs-trigger",
      className: te(
        "data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        e
      ),
      ...t
    }
  );
}
function Sa({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ r.jsx(
    _C,
    {
      "data-slot": "tabs-content",
      className: te("flex-1 outline-none", e),
      ...t
    }
  );
}
function Tu(e, [t, n]) {
  return Math.min(n, Math.max(t, e));
}
function RC(e, t) {
  return v.useReducer((n, a) => t[n][a] ?? n, e);
}
var Du = "ScrollArea", [Iv] = an(Du), [kC, Ct] = Iv(Du), Wv = v.forwardRef(
  (e, t) => {
    const {
      __scopeScrollArea: n,
      type: a = "hover",
      dir: l,
      scrollHideDelay: i = 600,
      ...o
    } = e, [s, c] = v.useState(null), [u, m] = v.useState(null), [g, f] = v.useState(null), [p, C] = v.useState(null), [x, S] = v.useState(null), [h, d] = v.useState(0), [y, b] = v.useState(0), [N, O] = v.useState(!1), [M, A] = v.useState(!1), w = Ee(t, (R) => c(R)), E = vl(l);
    return /* @__PURE__ */ r.jsx(
      kC,
      {
        scope: n,
        type: a,
        dir: E,
        scrollHideDelay: i,
        scrollArea: s,
        viewport: u,
        onViewportChange: m,
        content: g,
        onContentChange: f,
        scrollbarX: p,
        onScrollbarXChange: C,
        scrollbarXEnabled: N,
        onScrollbarXEnabledChange: O,
        scrollbarY: x,
        onScrollbarYChange: S,
        scrollbarYEnabled: M,
        onScrollbarYEnabledChange: A,
        onCornerWidthChange: d,
        onCornerHeightChange: b,
        children: /* @__PURE__ */ r.jsx(
          me.div,
          {
            dir: E,
            ...o,
            ref: w,
            style: {
              position: "relative",
              // Pass corner sizes as CSS vars to reduce re-renders of context consumers
              "--radix-scroll-area-corner-width": h + "px",
              "--radix-scroll-area-corner-height": y + "px",
              ...e.style
            }
          }
        )
      }
    );
  }
);
Wv.displayName = Du;
var $v = "ScrollAreaViewport", Pv = v.forwardRef(
  (e, t) => {
    const { __scopeScrollArea: n, children: a, nonce: l, ...i } = e, o = Ct($v, n), s = v.useRef(null), c = Ee(t, s, o.onViewportChange);
    return /* @__PURE__ */ r.jsxs(r.Fragment, { children: [
      /* @__PURE__ */ r.jsx(
        "style",
        {
          dangerouslySetInnerHTML: {
            __html: "[data-radix-scroll-area-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-scroll-area-viewport]::-webkit-scrollbar{display:none}"
          },
          nonce: l
        }
      ),
      /* @__PURE__ */ r.jsx(
        me.div,
        {
          "data-radix-scroll-area-viewport": "",
          ...i,
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
            overflowX: o.scrollbarXEnabled ? "scroll" : "hidden",
            overflowY: o.scrollbarYEnabled ? "scroll" : "hidden",
            ...e.style
          },
          children: /* @__PURE__ */ r.jsx("div", { ref: o.onContentChange, style: { minWidth: "100%", display: "table" }, children: a })
        }
      )
    ] });
  }
);
Pv.displayName = $v;
var zt = "ScrollAreaScrollbar", ep = v.forwardRef(
  (e, t) => {
    const { forceMount: n, ...a } = e, l = Ct(zt, e.__scopeScrollArea), { onScrollbarXEnabledChange: i, onScrollbarYEnabledChange: o } = l, s = e.orientation === "horizontal";
    return v.useEffect(() => (s ? i(!0) : o(!0), () => {
      s ? i(!1) : o(!1);
    }), [s, i, o]), l.type === "hover" ? /* @__PURE__ */ r.jsx(UC, { ...a, ref: t, forceMount: n }) : l.type === "scroll" ? /* @__PURE__ */ r.jsx(VC, { ...a, ref: t, forceMount: n }) : l.type === "auto" ? /* @__PURE__ */ r.jsx(tp, { ...a, ref: t, forceMount: n }) : l.type === "always" ? /* @__PURE__ */ r.jsx(_u, { ...a, ref: t }) : null;
  }
);
ep.displayName = zt;
var UC = v.forwardRef((e, t) => {
  const { forceMount: n, ...a } = e, l = Ct(zt, e.__scopeScrollArea), [i, o] = v.useState(!1);
  return v.useEffect(() => {
    const s = l.scrollArea;
    let c = 0;
    if (s) {
      const u = () => {
        window.clearTimeout(c), o(!0);
      }, m = () => {
        c = window.setTimeout(() => o(!1), l.scrollHideDelay);
      };
      return s.addEventListener("pointerenter", u), s.addEventListener("pointerleave", m), () => {
        window.clearTimeout(c), s.removeEventListener("pointerenter", u), s.removeEventListener("pointerleave", m);
      };
    }
  }, [l.scrollArea, l.scrollHideDelay]), /* @__PURE__ */ r.jsx(Qn, { present: n || i, children: /* @__PURE__ */ r.jsx(
    tp,
    {
      "data-state": i ? "visible" : "hidden",
      ...a,
      ref: t
    }
  ) });
}), VC = v.forwardRef((e, t) => {
  const { forceMount: n, ...a } = e, l = Ct(zt, e.__scopeScrollArea), i = e.orientation === "horizontal", o = Ss(() => c("SCROLL_END"), 100), [s, c] = RC("hidden", {
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
  return v.useEffect(() => {
    if (s === "idle") {
      const u = window.setTimeout(() => c("HIDE"), l.scrollHideDelay);
      return () => window.clearTimeout(u);
    }
  }, [s, l.scrollHideDelay, c]), v.useEffect(() => {
    const u = l.viewport, m = i ? "scrollLeft" : "scrollTop";
    if (u) {
      let g = u[m];
      const f = () => {
        const p = u[m];
        g !== p && (c("SCROLL"), o()), g = p;
      };
      return u.addEventListener("scroll", f), () => u.removeEventListener("scroll", f);
    }
  }, [l.viewport, i, c, o]), /* @__PURE__ */ r.jsx(Qn, { present: n || s !== "hidden", children: /* @__PURE__ */ r.jsx(
    _u,
    {
      "data-state": s === "hidden" ? "hidden" : "visible",
      ...a,
      ref: t,
      onPointerEnter: ue(e.onPointerEnter, () => c("POINTER_ENTER")),
      onPointerLeave: ue(e.onPointerLeave, () => c("POINTER_LEAVE"))
    }
  ) });
}), tp = v.forwardRef((e, t) => {
  const n = Ct(zt, e.__scopeScrollArea), { forceMount: a, ...l } = e, [i, o] = v.useState(!1), s = e.orientation === "horizontal", c = Ss(() => {
    if (n.viewport) {
      const u = n.viewport.offsetWidth < n.viewport.scrollWidth, m = n.viewport.offsetHeight < n.viewport.scrollHeight;
      o(s ? u : m);
    }
  }, 10);
  return il(n.viewport, c), il(n.content, c), /* @__PURE__ */ r.jsx(Qn, { present: a || i, children: /* @__PURE__ */ r.jsx(
    _u,
    {
      "data-state": i ? "visible" : "hidden",
      ...l,
      ref: t
    }
  ) });
}), _u = v.forwardRef((e, t) => {
  const { orientation: n = "vertical", ...a } = e, l = Ct(zt, e.__scopeScrollArea), i = v.useRef(null), o = v.useRef(0), [s, c] = v.useState({
    content: 0,
    viewport: 0,
    scrollbar: { size: 0, paddingStart: 0, paddingEnd: 0 }
  }), u = op(s.viewport, s.content), m = {
    ...a,
    sizes: s,
    onSizesChange: c,
    hasThumb: u > 0 && u < 1,
    onThumbChange: (f) => i.current = f,
    onThumbPointerUp: () => o.current = 0,
    onThumbPointerDown: (f) => o.current = f
  };
  function g(f, p) {
    return qC(f, o.current, s, p);
  }
  return n === "horizontal" ? /* @__PURE__ */ r.jsx(
    LC,
    {
      ...m,
      ref: t,
      onThumbPositionChange: () => {
        if (l.viewport && i.current) {
          const f = l.viewport.scrollLeft, p = Hd(f, s, l.dir);
          i.current.style.transform = `translate3d(${p}px, 0, 0)`;
        }
      },
      onWheelScroll: (f) => {
        l.viewport && (l.viewport.scrollLeft = f);
      },
      onDragScroll: (f) => {
        l.viewport && (l.viewport.scrollLeft = g(f, l.dir));
      }
    }
  ) : n === "vertical" ? /* @__PURE__ */ r.jsx(
    BC,
    {
      ...m,
      ref: t,
      onThumbPositionChange: () => {
        if (l.viewport && i.current) {
          const f = l.viewport.scrollTop, p = Hd(f, s);
          i.current.style.transform = `translate3d(0, ${p}px, 0)`;
        }
      },
      onWheelScroll: (f) => {
        l.viewport && (l.viewport.scrollTop = f);
      },
      onDragScroll: (f) => {
        l.viewport && (l.viewport.scrollTop = g(f));
      }
    }
  ) : null;
}), LC = v.forwardRef((e, t) => {
  const { sizes: n, onSizesChange: a, ...l } = e, i = Ct(zt, e.__scopeScrollArea), [o, s] = v.useState(), c = v.useRef(null), u = Ee(t, c, i.onScrollbarXChange);
  return v.useEffect(() => {
    c.current && s(getComputedStyle(c.current));
  }, [c]), /* @__PURE__ */ r.jsx(
    ap,
    {
      "data-orientation": "horizontal",
      ...l,
      ref: u,
      sizes: n,
      style: {
        bottom: 0,
        left: i.dir === "rtl" ? "var(--radix-scroll-area-corner-width)" : 0,
        right: i.dir === "ltr" ? "var(--radix-scroll-area-corner-width)" : 0,
        "--radix-scroll-area-thumb-width": xs(n) + "px",
        ...e.style
      },
      onThumbPointerDown: (m) => e.onThumbPointerDown(m.x),
      onDragScroll: (m) => e.onDragScroll(m.x),
      onWheelScroll: (m, g) => {
        if (i.viewport) {
          const f = i.viewport.scrollLeft + m.deltaX;
          e.onWheelScroll(f), rp(f, g) && m.preventDefault();
        }
      },
      onResize: () => {
        c.current && i.viewport && o && a({
          content: i.viewport.scrollWidth,
          viewport: i.viewport.offsetWidth,
          scrollbar: {
            size: c.current.clientWidth,
            paddingStart: Wo(o.paddingLeft),
            paddingEnd: Wo(o.paddingRight)
          }
        });
      }
    }
  );
}), BC = v.forwardRef((e, t) => {
  const { sizes: n, onSizesChange: a, ...l } = e, i = Ct(zt, e.__scopeScrollArea), [o, s] = v.useState(), c = v.useRef(null), u = Ee(t, c, i.onScrollbarYChange);
  return v.useEffect(() => {
    c.current && s(getComputedStyle(c.current));
  }, [c]), /* @__PURE__ */ r.jsx(
    ap,
    {
      "data-orientation": "vertical",
      ...l,
      ref: u,
      sizes: n,
      style: {
        top: 0,
        right: i.dir === "ltr" ? 0 : void 0,
        left: i.dir === "rtl" ? 0 : void 0,
        bottom: "var(--radix-scroll-area-corner-height)",
        "--radix-scroll-area-thumb-height": xs(n) + "px",
        ...e.style
      },
      onThumbPointerDown: (m) => e.onThumbPointerDown(m.y),
      onDragScroll: (m) => e.onDragScroll(m.y),
      onWheelScroll: (m, g) => {
        if (i.viewport) {
          const f = i.viewport.scrollTop + m.deltaY;
          e.onWheelScroll(f), rp(f, g) && m.preventDefault();
        }
      },
      onResize: () => {
        c.current && i.viewport && o && a({
          content: i.viewport.scrollHeight,
          viewport: i.viewport.offsetHeight,
          scrollbar: {
            size: c.current.clientHeight,
            paddingStart: Wo(o.paddingTop),
            paddingEnd: Wo(o.paddingBottom)
          }
        });
      }
    }
  );
}), [HC, np] = Iv(zt), ap = v.forwardRef((e, t) => {
  const {
    __scopeScrollArea: n,
    sizes: a,
    hasThumb: l,
    onThumbChange: i,
    onThumbPointerUp: o,
    onThumbPointerDown: s,
    onThumbPositionChange: c,
    onDragScroll: u,
    onWheelScroll: m,
    onResize: g,
    ...f
  } = e, p = Ct(zt, n), [C, x] = v.useState(null), S = Ee(t, (w) => x(w)), h = v.useRef(null), d = v.useRef(""), y = p.viewport, b = a.content - a.viewport, N = bn(m), O = bn(c), M = Ss(g, 10);
  function A(w) {
    if (h.current) {
      const E = w.clientX - h.current.left, R = w.clientY - h.current.top;
      u({ x: E, y: R });
    }
  }
  return v.useEffect(() => {
    const w = (E) => {
      const R = E.target;
      (C == null ? void 0 : C.contains(R)) && N(E, b);
    };
    return document.addEventListener("wheel", w, { passive: !1 }), () => document.removeEventListener("wheel", w, { passive: !1 });
  }, [y, C, b, N]), v.useEffect(O, [a, O]), il(C, M), il(p.content, M), /* @__PURE__ */ r.jsx(
    HC,
    {
      scope: n,
      scrollbar: C,
      hasThumb: l,
      onThumbChange: bn(i),
      onThumbPointerUp: bn(o),
      onThumbPositionChange: O,
      onThumbPointerDown: bn(s),
      children: /* @__PURE__ */ r.jsx(
        me.div,
        {
          ...f,
          ref: S,
          style: { position: "absolute", ...f.style },
          onPointerDown: ue(e.onPointerDown, (w) => {
            w.button === 0 && (w.target.setPointerCapture(w.pointerId), h.current = C.getBoundingClientRect(), d.current = document.body.style.webkitUserSelect, document.body.style.webkitUserSelect = "none", p.viewport && (p.viewport.style.scrollBehavior = "auto"), A(w));
          }),
          onPointerMove: ue(e.onPointerMove, A),
          onPointerUp: ue(e.onPointerUp, (w) => {
            const E = w.target;
            E.hasPointerCapture(w.pointerId) && E.releasePointerCapture(w.pointerId), document.body.style.webkitUserSelect = d.current, p.viewport && (p.viewport.style.scrollBehavior = ""), h.current = null;
          })
        }
      )
    }
  );
}), Io = "ScrollAreaThumb", lp = v.forwardRef(
  (e, t) => {
    const { forceMount: n, ...a } = e, l = np(Io, e.__scopeScrollArea);
    return /* @__PURE__ */ r.jsx(Qn, { present: n || l.hasThumb, children: /* @__PURE__ */ r.jsx(GC, { ref: t, ...a }) });
  }
), GC = v.forwardRef(
  (e, t) => {
    const { __scopeScrollArea: n, style: a, ...l } = e, i = Ct(Io, n), o = np(Io, n), { onThumbPositionChange: s } = o, c = Ee(
      t,
      (g) => o.onThumbChange(g)
    ), u = v.useRef(void 0), m = Ss(() => {
      u.current && (u.current(), u.current = void 0);
    }, 100);
    return v.useEffect(() => {
      const g = i.viewport;
      if (g) {
        const f = () => {
          if (m(), !u.current) {
            const p = XC(g, s);
            u.current = p, s();
          }
        };
        return s(), g.addEventListener("scroll", f), () => g.removeEventListener("scroll", f);
      }
    }, [i.viewport, m, s]), /* @__PURE__ */ r.jsx(
      me.div,
      {
        "data-state": o.hasThumb ? "visible" : "hidden",
        ...l,
        ref: c,
        style: {
          width: "var(--radix-scroll-area-thumb-width)",
          height: "var(--radix-scroll-area-thumb-height)",
          ...a
        },
        onPointerDownCapture: ue(e.onPointerDownCapture, (g) => {
          const p = g.target.getBoundingClientRect(), C = g.clientX - p.left, x = g.clientY - p.top;
          o.onThumbPointerDown({ x: C, y: x });
        }),
        onPointerUp: ue(e.onPointerUp, o.onThumbPointerUp)
      }
    );
  }
);
lp.displayName = Io;
var Ou = "ScrollAreaCorner", ip = v.forwardRef(
  (e, t) => {
    const n = Ct(Ou, e.__scopeScrollArea), a = !!(n.scrollbarX && n.scrollbarY);
    return n.type !== "scroll" && a ? /* @__PURE__ */ r.jsx(YC, { ...e, ref: t }) : null;
  }
);
ip.displayName = Ou;
var YC = v.forwardRef((e, t) => {
  const { __scopeScrollArea: n, ...a } = e, l = Ct(Ou, n), [i, o] = v.useState(0), [s, c] = v.useState(0), u = !!(i && s);
  return il(l.scrollbarX, () => {
    var g;
    const m = ((g = l.scrollbarX) == null ? void 0 : g.offsetHeight) || 0;
    l.onCornerHeightChange(m), c(m);
  }), il(l.scrollbarY, () => {
    var g;
    const m = ((g = l.scrollbarY) == null ? void 0 : g.offsetWidth) || 0;
    l.onCornerWidthChange(m), o(m);
  }), u ? /* @__PURE__ */ r.jsx(
    me.div,
    {
      ...a,
      ref: t,
      style: {
        width: i,
        height: s,
        position: "absolute",
        right: l.dir === "ltr" ? 0 : void 0,
        left: l.dir === "rtl" ? 0 : void 0,
        bottom: 0,
        ...e.style
      }
    }
  ) : null;
});
function Wo(e) {
  return e ? parseInt(e, 10) : 0;
}
function op(e, t) {
  const n = e / t;
  return isNaN(n) ? 0 : n;
}
function xs(e) {
  const t = op(e.viewport, e.content), n = e.scrollbar.paddingStart + e.scrollbar.paddingEnd, a = (e.scrollbar.size - n) * t;
  return Math.max(a, 18);
}
function qC(e, t, n, a = "ltr") {
  const l = xs(n), i = l / 2, o = t || i, s = l - o, c = n.scrollbar.paddingStart + o, u = n.scrollbar.size - n.scrollbar.paddingEnd - s, m = n.content - n.viewport, g = a === "ltr" ? [0, m] : [m * -1, 0];
  return sp([c, u], g)(e);
}
function Hd(e, t, n = "ltr") {
  const a = xs(t), l = t.scrollbar.paddingStart + t.scrollbar.paddingEnd, i = t.scrollbar.size - l, o = t.content - t.viewport, s = i - a, c = n === "ltr" ? [0, o] : [o * -1, 0], u = Tu(e, c);
  return sp([0, o], [0, s])(u);
}
function sp(e, t) {
  return (n) => {
    if (e[0] === e[1] || t[0] === t[1]) return t[0];
    const a = (t[1] - t[0]) / (e[1] - e[0]);
    return t[0] + a * (n - e[0]);
  };
}
function rp(e, t) {
  return e > 0 && e < t;
}
var XC = (e, t = () => {
}) => {
  let n = { left: e.scrollLeft, top: e.scrollTop }, a = 0;
  return function l() {
    const i = { left: e.scrollLeft, top: e.scrollTop }, o = n.left !== i.left, s = n.top !== i.top;
    (o || s) && t(), n = i, a = window.requestAnimationFrame(l);
  }(), () => window.cancelAnimationFrame(a);
};
function Ss(e, t) {
  const n = bn(e), a = v.useRef(0);
  return v.useEffect(() => () => window.clearTimeout(a.current), []), v.useCallback(() => {
    window.clearTimeout(a.current), a.current = window.setTimeout(n, t);
  }, [n, t]);
}
function il(e, t) {
  const n = bn(t);
  ll(() => {
    let a = 0;
    if (e) {
      const l = new ResizeObserver(() => {
        cancelAnimationFrame(a), a = window.requestAnimationFrame(n);
      });
      return l.observe(e), () => {
        window.cancelAnimationFrame(a), l.unobserve(e);
      };
    }
  }, [e, n]);
}
var QC = Wv, ZC = Pv, FC = ip;
function Hn({
  className: e,
  children: t,
  ...n
}) {
  return /* @__PURE__ */ r.jsxs(
    QC,
    {
      "data-slot": "scroll-area",
      className: te("relative", e),
      ...n,
      children: [
        /* @__PURE__ */ r.jsx(
          ZC,
          {
            "data-slot": "scroll-area-viewport",
            className: "focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1",
            children: t
          }
        ),
        /* @__PURE__ */ r.jsx(KC, {}),
        /* @__PURE__ */ r.jsx(FC, {})
      ]
    }
  );
}
function KC({
  className: e,
  orientation: t = "vertical",
  ...n
}) {
  return /* @__PURE__ */ r.jsx(
    ep,
    {
      "data-slot": "scroll-area-scrollbar",
      orientation: t,
      className: te(
        "flex touch-none p-px transition-colors select-none",
        t === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        t === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        e
      ),
      ...n,
      children: /* @__PURE__ */ r.jsx(
        lp,
        {
          "data-slot": "scroll-area-thumb",
          className: "bg-border relative flex-1 rounded-full"
        }
      )
    }
  );
}
const cp = ({
  endpoint: e,
  onFileSelect: t,
  emptyMessage: n = "No files available."
}) => {
  const [a, l] = v.useState([]), [i, o] = v.useState(!1), [s, c] = v.useState("");
  return v.useEffect(() => {
    (async () => {
      o(!0);
      try {
        const m = await fetch(e);
        if (console.log(`Fetching from ${e}:`, m), !m.ok)
          throw new Error(`HTTP error! Status: ${m.status}`);
        const g = await m.json();
        console.log(`Files from ${e}:`, g), l(g);
      } catch (m) {
        console.error(`Error fetching files from ${e}:`, m), c(m instanceof Error ? m.message : String(m));
      } finally {
        o(!1);
      }
    })();
  }, [e]), /* @__PURE__ */ r.jsxs("div", { children: [
    i && /* @__PURE__ */ r.jsx("p", { children: "Loading List..." }),
    s && /* @__PURE__ */ r.jsxs("p", { style: { color: "red" }, children: [
      "Error: ",
      s
    ] }),
    !i && !s && (a.length > 0 ? /* @__PURE__ */ r.jsx("ul", { className: "space-y-1", children: a.map((u, m) => /* @__PURE__ */ r.jsx(
      "li",
      {
        className: "cursor-pointer px-3 py-2 rounded-md text-sm hover:bg-accent hover:text-accent-foreground transition-colors",
        onClick: () => t(u),
        children: u.filename
      },
      m
    )) }) : /* @__PURE__ */ r.jsx("p", { children: n }))
  ] });
};
function JC({ onFileSelect: e }) {
  return /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ r.jsxs("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ r.jsx("h2", { className: "text-lg font-semibold", children: "Backend: NiiVue Documents" }),
      /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground", children: "Load complete scenes and visualizations" })
    ] }),
    /* @__PURE__ */ r.jsx(Hn, { className: "flex-1 min-h-0", children: /* @__PURE__ */ r.jsx("div", { className: "p-4 pb-6", children: /* @__PURE__ */ r.jsx(
      cp,
      {
        endpoint: Et("nvd"),
        onFileSelect: e,
        emptyMessage: "No niivue documents available."
      }
    ) }) })
  ] });
}
function IC({ onFileSelect: e }) {
  return /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ r.jsxs("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ r.jsx("h2", { className: "text-lg font-semibold", children: "Backend: Imaging Data" }),
      /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground", children: "Add individual volumes to the current scene" })
    ] }),
    /* @__PURE__ */ r.jsx(Hn, { className: "flex-1 min-h-0", children: /* @__PURE__ */ r.jsx("div", { className: "p-4 pb-6", children: /* @__PURE__ */ r.jsx(
      cp,
      {
        endpoint: Et("vol"),
        onFileSelect: e,
        emptyMessage: "No imaging files available."
      }
    ) }) })
  ] });
}
var WC = [
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
], $C = WC.reduce((e, t) => {
  const n = /* @__PURE__ */ Sv(`Primitive.${t}`), a = v.forwardRef((l, i) => {
    const { asChild: o, ...s } = l, c = o ? n : t;
    return typeof window < "u" && (window[Symbol.for("radix-ui")] = !0), /* @__PURE__ */ r.jsx(c, { ...s, ref: i });
  });
  return a.displayName = `Primitive.${t}`, { ...e, [t]: a };
}, {}), PC = "Label", up = v.forwardRef((e, t) => /* @__PURE__ */ r.jsx(
  $C.label,
  {
    ...e,
    ref: t,
    onMouseDown: (n) => {
      var l;
      n.target.closest("button, input, select, textarea") || ((l = e.onMouseDown) == null || l.call(e, n), !n.defaultPrevented && n.detail > 1 && n.preventDefault());
    }
  }
));
up.displayName = PC;
var ew = up;
function F({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ r.jsx(
    ew,
    {
      "data-slot": "label",
      className: te(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        e
      ),
      ...t
    }
  );
}
function zu(e) {
  const t = v.useRef({ value: e, previous: e });
  return v.useMemo(() => (t.current.value !== e && (t.current.previous = t.current.value, t.current.value = e), t.current.previous), [e]);
}
function Ru(e) {
  const [t, n] = v.useState(void 0);
  return ll(() => {
    if (e) {
      n({ width: e.offsetWidth, height: e.offsetHeight });
      const a = new ResizeObserver((l) => {
        if (!Array.isArray(l) || !l.length)
          return;
        const i = l[0];
        let o, s;
        if ("borderBoxSize" in i) {
          const c = i.borderBoxSize, u = Array.isArray(c) ? c[0] : c;
          o = u.inlineSize, s = u.blockSize;
        } else
          o = e.offsetWidth, s = e.offsetHeight;
        n({ width: o, height: s });
      });
      return a.observe(e, { box: "border-box" }), () => a.unobserve(e);
    } else
      n(void 0);
  }, [e]), t;
}
var fp = ["PageUp", "PageDown"], dp = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], mp = {
  "from-left": ["Home", "PageDown", "ArrowDown", "ArrowLeft"],
  "from-right": ["Home", "PageDown", "ArrowDown", "ArrowRight"],
  "from-bottom": ["Home", "PageDown", "ArrowDown", "ArrowLeft"],
  "from-top": ["Home", "PageDown", "ArrowUp", "ArrowLeft"]
}, yl = "Slider", [gc, tw, nw] = wv(yl), [hp] = an(yl, [
  nw
]), [aw, Cs] = hp(yl), gp = v.forwardRef(
  (e, t) => {
    const {
      name: n,
      min: a = 0,
      max: l = 100,
      step: i = 1,
      orientation: o = "horizontal",
      disabled: s = !1,
      minStepsBetweenThumbs: c = 0,
      defaultValue: u = [a],
      value: m,
      onValueChange: g = () => {
      },
      onValueCommit: f = () => {
      },
      inverted: p = !1,
      form: C,
      ...x
    } = e, S = v.useRef(/* @__PURE__ */ new Set()), h = v.useRef(0), y = o === "horizontal" ? lw : iw, [b = [], N] = qn({
      prop: m,
      defaultProp: u,
      onChange: (R) => {
        var V;
        (V = [...S.current][h.current]) == null || V.focus(), g(R);
      }
    }), O = v.useRef(b);
    function M(R) {
      const k = uw(b, R);
      E(R, k);
    }
    function A(R) {
      E(R, h.current);
    }
    function w() {
      const R = O.current[h.current];
      b[h.current] !== R && f(b);
    }
    function E(R, k, { commit: V } = { commit: !1 }) {
      const J = hw(i), z = gw(Math.round((R - a) / i) * i + a, J), j = Tu(z, [a, l]);
      N((U = []) => {
        const D = rw(U, j, k);
        if (mw(D, c * i)) {
          h.current = D.indexOf(j);
          const Q = String(D) !== String(U);
          return Q && V && f(D), Q ? D : U;
        } else
          return U;
      });
    }
    return /* @__PURE__ */ r.jsx(
      aw,
      {
        scope: e.__scopeSlider,
        name: n,
        disabled: s,
        min: a,
        max: l,
        valueIndexToChangeRef: h,
        thumbs: S.current,
        values: b,
        orientation: o,
        form: C,
        children: /* @__PURE__ */ r.jsx(gc.Provider, { scope: e.__scopeSlider, children: /* @__PURE__ */ r.jsx(gc.Slot, { scope: e.__scopeSlider, children: /* @__PURE__ */ r.jsx(
          y,
          {
            "aria-disabled": s,
            "data-disabled": s ? "" : void 0,
            ...x,
            ref: t,
            onPointerDown: ue(x.onPointerDown, () => {
              s || (O.current = b);
            }),
            min: a,
            max: l,
            inverted: p,
            onSlideStart: s ? void 0 : M,
            onSlideMove: s ? void 0 : A,
            onSlideEnd: s ? void 0 : w,
            onHomeKeyDown: () => !s && E(a, 0, { commit: !0 }),
            onEndKeyDown: () => !s && E(l, b.length - 1, { commit: !0 }),
            onStepKeyDown: ({ event: R, direction: k }) => {
              if (!s) {
                const z = fp.includes(R.key) || R.shiftKey && dp.includes(R.key) ? 10 : 1, j = h.current, U = b[j], D = i * z * k;
                E(U + D, j, { commit: !0 });
              }
            }
          }
        ) }) })
      }
    );
  }
);
gp.displayName = yl;
var [vp, pp] = hp(yl, {
  startEdge: "left",
  endEdge: "right",
  size: "width",
  direction: 1
}), lw = v.forwardRef(
  (e, t) => {
    const {
      min: n,
      max: a,
      dir: l,
      inverted: i,
      onSlideStart: o,
      onSlideMove: s,
      onSlideEnd: c,
      onStepKeyDown: u,
      ...m
    } = e, [g, f] = v.useState(null), p = Ee(t, (y) => f(y)), C = v.useRef(void 0), x = vl(l), S = x === "ltr", h = S && !i || !S && i;
    function d(y) {
      const b = C.current || g.getBoundingClientRect(), N = [0, b.width], M = ku(N, h ? [n, a] : [a, n]);
      return C.current = b, M(y - b.left);
    }
    return /* @__PURE__ */ r.jsx(
      vp,
      {
        scope: e.__scopeSlider,
        startEdge: h ? "left" : "right",
        endEdge: h ? "right" : "left",
        direction: h ? 1 : -1,
        size: "width",
        children: /* @__PURE__ */ r.jsx(
          yp,
          {
            dir: x,
            "data-orientation": "horizontal",
            ...m,
            ref: p,
            style: {
              ...m.style,
              "--radix-slider-thumb-transform": "translateX(-50%)"
            },
            onSlideStart: (y) => {
              const b = d(y.clientX);
              o == null || o(b);
            },
            onSlideMove: (y) => {
              const b = d(y.clientX);
              s == null || s(b);
            },
            onSlideEnd: () => {
              C.current = void 0, c == null || c();
            },
            onStepKeyDown: (y) => {
              const N = mp[h ? "from-left" : "from-right"].includes(y.key);
              u == null || u({ event: y, direction: N ? -1 : 1 });
            }
          }
        )
      }
    );
  }
), iw = v.forwardRef(
  (e, t) => {
    const {
      min: n,
      max: a,
      inverted: l,
      onSlideStart: i,
      onSlideMove: o,
      onSlideEnd: s,
      onStepKeyDown: c,
      ...u
    } = e, m = v.useRef(null), g = Ee(t, m), f = v.useRef(void 0), p = !l;
    function C(x) {
      const S = f.current || m.current.getBoundingClientRect(), h = [0, S.height], y = ku(h, p ? [a, n] : [n, a]);
      return f.current = S, y(x - S.top);
    }
    return /* @__PURE__ */ r.jsx(
      vp,
      {
        scope: e.__scopeSlider,
        startEdge: p ? "bottom" : "top",
        endEdge: p ? "top" : "bottom",
        size: "height",
        direction: p ? 1 : -1,
        children: /* @__PURE__ */ r.jsx(
          yp,
          {
            "data-orientation": "vertical",
            ...u,
            ref: g,
            style: {
              ...u.style,
              "--radix-slider-thumb-transform": "translateY(50%)"
            },
            onSlideStart: (x) => {
              const S = C(x.clientY);
              i == null || i(S);
            },
            onSlideMove: (x) => {
              const S = C(x.clientY);
              o == null || o(S);
            },
            onSlideEnd: () => {
              f.current = void 0, s == null || s();
            },
            onStepKeyDown: (x) => {
              const h = mp[p ? "from-bottom" : "from-top"].includes(x.key);
              c == null || c({ event: x, direction: h ? -1 : 1 });
            }
          }
        )
      }
    );
  }
), yp = v.forwardRef(
  (e, t) => {
    const {
      __scopeSlider: n,
      onSlideStart: a,
      onSlideMove: l,
      onSlideEnd: i,
      onHomeKeyDown: o,
      onEndKeyDown: s,
      onStepKeyDown: c,
      ...u
    } = e, m = Cs(yl, n);
    return /* @__PURE__ */ r.jsx(
      me.span,
      {
        ...u,
        ref: t,
        onKeyDown: ue(e.onKeyDown, (g) => {
          g.key === "Home" ? (o(g), g.preventDefault()) : g.key === "End" ? (s(g), g.preventDefault()) : fp.concat(dp).includes(g.key) && (c(g), g.preventDefault());
        }),
        onPointerDown: ue(e.onPointerDown, (g) => {
          const f = g.target;
          f.setPointerCapture(g.pointerId), g.preventDefault(), m.thumbs.has(f) ? f.focus() : a(g);
        }),
        onPointerMove: ue(e.onPointerMove, (g) => {
          g.target.hasPointerCapture(g.pointerId) && l(g);
        }),
        onPointerUp: ue(e.onPointerUp, (g) => {
          const f = g.target;
          f.hasPointerCapture(g.pointerId) && (f.releasePointerCapture(g.pointerId), i(g));
        })
      }
    );
  }
), bp = "SliderTrack", xp = v.forwardRef(
  (e, t) => {
    const { __scopeSlider: n, ...a } = e, l = Cs(bp, n);
    return /* @__PURE__ */ r.jsx(
      me.span,
      {
        "data-disabled": l.disabled ? "" : void 0,
        "data-orientation": l.orientation,
        ...a,
        ref: t
      }
    );
  }
);
xp.displayName = bp;
var vc = "SliderRange", Sp = v.forwardRef(
  (e, t) => {
    const { __scopeSlider: n, ...a } = e, l = Cs(vc, n), i = pp(vc, n), o = v.useRef(null), s = Ee(t, o), c = l.values.length, u = l.values.map(
      (f) => Ap(f, l.min, l.max)
    ), m = c > 1 ? Math.min(...u) : 0, g = 100 - Math.max(...u);
    return /* @__PURE__ */ r.jsx(
      me.span,
      {
        "data-orientation": l.orientation,
        "data-disabled": l.disabled ? "" : void 0,
        ...a,
        ref: s,
        style: {
          ...e.style,
          [i.startEdge]: m + "%",
          [i.endEdge]: g + "%"
        }
      }
    );
  }
);
Sp.displayName = vc;
var pc = "SliderThumb", Cp = v.forwardRef(
  (e, t) => {
    const n = tw(e.__scopeSlider), [a, l] = v.useState(null), i = Ee(t, (s) => l(s)), o = v.useMemo(
      () => a ? n().findIndex((s) => s.ref.current === a) : -1,
      [n, a]
    );
    return /* @__PURE__ */ r.jsx(ow, { ...e, ref: i, index: o });
  }
), ow = v.forwardRef(
  (e, t) => {
    const { __scopeSlider: n, index: a, name: l, ...i } = e, o = Cs(pc, n), s = pp(pc, n), [c, u] = v.useState(null), m = Ee(t, (d) => u(d)), g = c ? o.form || !!c.closest("form") : !0, f = Ru(c), p = o.values[a], C = p === void 0 ? 0 : Ap(p, o.min, o.max), x = cw(a, o.values.length), S = f == null ? void 0 : f[s.size], h = S ? fw(S, C, s.direction) : 0;
    return v.useEffect(() => {
      if (c)
        return o.thumbs.add(c), () => {
          o.thumbs.delete(c);
        };
    }, [c, o.thumbs]), /* @__PURE__ */ r.jsxs(
      "span",
      {
        style: {
          transform: "var(--radix-slider-thumb-transform)",
          position: "absolute",
          [s.startEdge]: `calc(${C}% + ${h}px)`
        },
        children: [
          /* @__PURE__ */ r.jsx(gc.ItemSlot, { scope: e.__scopeSlider, children: /* @__PURE__ */ r.jsx(
            me.span,
            {
              role: "slider",
              "aria-label": e["aria-label"] || x,
              "aria-valuemin": o.min,
              "aria-valuenow": p,
              "aria-valuemax": o.max,
              "aria-orientation": o.orientation,
              "data-orientation": o.orientation,
              "data-disabled": o.disabled ? "" : void 0,
              tabIndex: o.disabled ? void 0 : 0,
              ...i,
              ref: m,
              style: p === void 0 ? { display: "none" } : e.style,
              onFocus: ue(e.onFocus, () => {
                o.valueIndexToChangeRef.current = a;
              })
            }
          ) }),
          g && /* @__PURE__ */ r.jsx(
            wp,
            {
              name: l ?? (o.name ? o.name + (o.values.length > 1 ? "[]" : "") : void 0),
              form: o.form,
              value: p
            },
            a
          )
        ]
      }
    );
  }
);
Cp.displayName = pc;
var sw = "RadioBubbleInput", wp = v.forwardRef(
  ({ __scopeSlider: e, value: t, ...n }, a) => {
    const l = v.useRef(null), i = Ee(l, a), o = zu(t);
    return v.useEffect(() => {
      const s = l.current;
      if (!s) return;
      const c = window.HTMLInputElement.prototype, m = Object.getOwnPropertyDescriptor(c, "value").set;
      if (o !== t && m) {
        const g = new Event("input", { bubbles: !0 });
        m.call(s, t), s.dispatchEvent(g);
      }
    }, [o, t]), /* @__PURE__ */ r.jsx(
      me.input,
      {
        style: { display: "none" },
        ...n,
        ref: i,
        defaultValue: t
      }
    );
  }
);
wp.displayName = sw;
function rw(e = [], t, n) {
  const a = [...e];
  return a[n] = t, a.sort((l, i) => l - i);
}
function Ap(e, t, n) {
  const i = 100 / (n - t) * (e - t);
  return Tu(i, [0, 100]);
}
function cw(e, t) {
  return t > 2 ? `Value ${e + 1} of ${t}` : t === 2 ? ["Minimum", "Maximum"][e] : void 0;
}
function uw(e, t) {
  if (e.length === 1) return 0;
  const n = e.map((l) => Math.abs(l - t)), a = Math.min(...n);
  return n.indexOf(a);
}
function fw(e, t, n) {
  const a = e / 2, i = ku([0, 50], [0, a]);
  return (a - i(t) * n) * n;
}
function dw(e) {
  return e.slice(0, -1).map((t, n) => e[n + 1] - t);
}
function mw(e, t) {
  if (t > 0) {
    const n = dw(e);
    return Math.min(...n) >= t;
  }
  return !0;
}
function ku(e, t) {
  return (n) => {
    if (e[0] === e[1] || t[0] === t[1]) return t[0];
    const a = (t[1] - t[0]) / (e[1] - e[0]);
    return t[0] + a * (n - e[0]);
  };
}
function hw(e) {
  return (String(e).split(".")[1] || "").length;
}
function gw(e, t) {
  const n = Math.pow(10, t);
  return Math.round(e * n) / n;
}
var vw = gp, pw = xp, yw = Sp, bw = Cp;
function xw({
  className: e,
  defaultValue: t,
  value: n,
  min: a = 0,
  max: l = 100,
  ...i
}) {
  const o = v.useMemo(
    () => Array.isArray(n) ? n : Array.isArray(t) ? t : [a, l],
    [n, t, a, l]
  );
  return /* @__PURE__ */ r.jsxs(
    vw,
    {
      "data-slot": "slider",
      defaultValue: t,
      value: n,
      min: a,
      max: l,
      className: te(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        e
      ),
      ...i,
      children: [
        /* @__PURE__ */ r.jsx(
          pw,
          {
            "data-slot": "slider-track",
            className: te(
              "bg-muted relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
            ),
            children: /* @__PURE__ */ r.jsx(
              yw,
              {
                "data-slot": "slider-range",
                className: te(
                  "bg-primary absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
                )
              }
            )
          }
        ),
        Array.from({ length: o.length }, (s, c) => /* @__PURE__ */ r.jsx(
          bw,
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
const ca = v.forwardRef(
  ({ className: e, type: t, ...n }, a) => /* @__PURE__ */ r.jsx(
    "input",
    {
      type: t,
      className: te(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ref: a,
      ...n
    }
  )
);
ca.displayName = "Input";
const _e = v.forwardRef(
  ({
    label: e,
    value: t,
    onValueChange: n,
    min: a = 0,
    max: l = 100,
    step: i = 1,
    decimalPlaces: o = 2,
    className: s,
    disabled: c = !1,
    ...u
  }, m) => {
    const [g, f] = v.useState(t), p = v.useRef(void 0), C = (y) => Number(y.toFixed(o));
    v.useEffect(() => {
      f(t);
    }, [t]);
    const x = v.useCallback((y) => {
      p.current && clearTimeout(p.current), p.current = setTimeout(() => {
        n(y);
      }, 50);
    }, [n]), S = (y) => {
      const b = y[0];
      f(b), x(b);
    }, h = (y) => {
      const b = parseFloat(y.target.value);
      if (!isNaN(b)) {
        const N = Math.min(Math.max(b, a), l);
        f(N), x(N);
      }
    }, d = (y) => {
      const b = parseFloat(y.target.value);
      (isNaN(b) || b < a || b > l) && (f(t), y.target.value = t.toString());
    };
    return /* @__PURE__ */ r.jsxs(
      "div",
      {
        ref: m,
        className: te("space-y-2", s),
        ...u,
        children: [
          /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: e }),
          /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-3", children: [
            /* @__PURE__ */ r.jsx(
              xw,
              {
                value: [g],
                onValueChange: S,
                min: a,
                max: l,
                step: i,
                disabled: c,
                className: "flex-1"
              }
            ),
            /* @__PURE__ */ r.jsx(
              ca,
              {
                type: "number",
                value: C(g),
                onChange: h,
                onBlur: d,
                min: a,
                max: l,
                step: i,
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
_e.displayName = "LabeledSliderWithInput";
const It = v.forwardRef(
  ({ className: e, children: t, ...n }, a) => /* @__PURE__ */ r.jsx(
    "select",
    {
      className: te(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ref: a,
      ...n,
      children: t
    }
  )
);
It.displayName = "Select";
function Sw({
  nvRef: e,
  serverlessMode: t,
  getVolumes: n,
  onToggleVisibility: a,
  onEditVolume: l,
  canEditVolume: i,
  onRemoveVolume: o,
  onAddMoreFiles: s,
  onCreateDrawingLayer: c,
  onSaveScene: u,
  onOpacityChange: m,
  onFrameChange: g,
  onContrastMinChange: f,
  onContrastMaxChange: p,
  onColormapChange: C,
  onMoveVolumeUp: x,
  onMoveVolumeDown: S
}) {
  var O;
  const h = T((M) => M.currentImageIndex), d = T(
    (M) => M.setCurrentImageIndex
  ), y = T((M) => M.drawingOptions), b = n(), N = h !== null ? b[h] : null;
  return /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ r.jsxs("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ r.jsx("h2", { className: "text-lg font-semibold", children: "Volumetric Details" }),
      /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground", children: "Manage volumes and adjust properties" })
    ] }),
    /* @__PURE__ */ r.jsxs(Hn, { className: "max-h-[50%] min-h-0", children: [
      b.length > 0 ? /* @__PURE__ */ r.jsx("div", { className: "grid gap-2 p-4", children: b.map((M, A) => /* @__PURE__ */ r.jsxs(
        "div",
        {
          className: te(
            "flex items-center gap-2 p-2 rounded-md cursor-pointer",
            h === A ? "bg-muted" : "hover:bg-muted/50"
          ),
          onClick: () => d(A),
          children: [
            /* @__PURE__ */ r.jsx("div", { className: "flex-shrink-0", children: /* @__PURE__ */ r.jsx(
              q,
              {
                variant: "ghost",
                size: "sm",
                className: "h-6 w-6 p-0",
                onClick: (w) => {
                  w.stopPropagation(), M.id && a(M.id);
                },
                children: M.visible !== !1 ? /* @__PURE__ */ r.jsx(wu, { className: "h-3 w-3" }) : /* @__PURE__ */ r.jsx(Cu, { className: "h-3 w-3 opacity-50" })
              }
            ) }),
            /* @__PURE__ */ r.jsx("div", { className: "flex-1 w-0", children: /* @__PURE__ */ r.jsx("p", { className: "text-sm font-medium break-words", children: M.name || `Volume ${A + 1}` }) }),
            /* @__PURE__ */ r.jsxs("div", { className: "flex-shrink-0 flex gap-1", children: [
              /* @__PURE__ */ r.jsx(
                q,
                {
                  variant: "ghost",
                  size: "sm",
                  className: "h-6 w-6 p-0 hover:bg-blue-100 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent",
                  onClick: (w) => {
                    w.stopPropagation(), l(A);
                  },
                  disabled: !i(A),
                  title: i(A) ? "Edit as drawing" : "Cannot edit - must match background dimensions and affine",
                  children: /* @__PURE__ */ r.jsx(c2, { className: "h-3 w-3" })
                }
              ),
              /* @__PURE__ */ r.jsx(
                q,
                {
                  variant: "ghost",
                  size: "sm",
                  className: "h-6 w-6 p-0 hover:bg-destructive hover:text-destructive-foreground",
                  onClick: (w) => {
                    w.stopPropagation(), o(A);
                  },
                  title: "Delete volume",
                  children: /* @__PURE__ */ r.jsx(Fo, { className: "h-3 w-3" })
                }
              )
            ] })
          ]
        },
        M.id
      )) }) : /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground", children: [
        /* @__PURE__ */ r.jsx(US, { className: "h-8 w-8 mb-2" }),
        /* @__PURE__ */ r.jsx("p", { children: "No images" })
      ] }),
      /* @__PURE__ */ r.jsxs("div", { className: "p-2 border-t space-y-2", children: [
        /* @__PURE__ */ r.jsxs(
          q,
          {
            variant: "outline",
            size: "sm",
            className: "w-full",
            onClick: s,
            children: [
              /* @__PURE__ */ r.jsx(fi, { className: "mr-2 h-4 w-4" }),
              "Load volumes"
            ]
          }
        ),
        /* @__PURE__ */ r.jsxs(
          q,
          {
            variant: "outline",
            size: "sm",
            className: "w-full",
            onClick: c,
            disabled: y.enabled || b.length === 0,
            children: [
              /* @__PURE__ */ r.jsx(Au, { className: "mr-2 h-4 w-4" }),
              "Create empty drawing layer"
            ]
          }
        ),
        /* @__PURE__ */ r.jsxs("div", { className: "flex gap-2", children: [
          /* @__PURE__ */ r.jsxs(
            q,
            {
              variant: "outline",
              size: "sm",
              className: "flex-1",
              onClick: () => u(!1),
              disabled: b.length === 0 || y.enabled || t,
              children: [
                /* @__PURE__ */ r.jsx(yv, { className: "mr-2 h-4 w-4" }),
                "Save"
              ]
            }
          ),
          /* @__PURE__ */ r.jsxs(
            q,
            {
              variant: "outline",
              size: "sm",
              className: "flex-1",
              onClick: () => u(!0),
              disabled: b.length === 0 || y.enabled || Qo.downloadDisabled,
              title: Qo.downloadDisabled ? "Download is disabled in this deployment" : void 0,
              children: [
                /* @__PURE__ */ r.jsx(ES, { className: "mr-2 h-4 w-4" }),
                "Download"
              ]
            }
          )
        ] })
      ] })
    ] }),
    /* @__PURE__ */ r.jsx(Hn, { className: "flex-1 min-h-0", children: N ? /* @__PURE__ */ r.jsxs("div", { className: "grid gap-4 p-4", children: [
      /* @__PURE__ */ r.jsxs("div", { className: "flex gap-2", children: [
        /* @__PURE__ */ r.jsxs(
          q,
          {
            variant: "outline",
            size: "sm",
            className: "flex-1",
            onClick: x,
            disabled: h === null || h === 0,
            children: [
              /* @__PURE__ */ r.jsx(hS, { className: "mr-2 h-4 w-4" }),
              "Move up"
            ]
          }
        ),
        /* @__PURE__ */ r.jsxs(
          q,
          {
            variant: "outline",
            size: "sm",
            className: "flex-1",
            onClick: S,
            disabled: h === null || h === b.length - 1,
            children: [
              /* @__PURE__ */ r.jsx(dS, { className: "mr-2 h-4 w-4" }),
              "Move down"
            ]
          }
        )
      ] }),
      (N.nFrame4D || 1) > 1 && /* @__PURE__ */ r.jsx(
        _e,
        {
          label: "Frame",
          value: N.frame4D ?? 0,
          onValueChange: g,
          min: 0,
          max: (N.nFrame4D || 1) - 1,
          step: 1
        }
      ),
      /* @__PURE__ */ r.jsx(
        _e,
        {
          label: "Opacity",
          value: N.opacity ?? 1,
          onValueChange: m,
          min: 0,
          max: 1,
          step: 0.01
        }
      ),
      /* @__PURE__ */ r.jsx(
        _e,
        {
          label: "Contrast Min",
          value: N.calMin ?? 0,
          onValueChange: f,
          min: N.globalMin ?? 0,
          max: N.globalMax ?? 255,
          step: 0.1,
          decimalPlaces: 1
        }
      ),
      /* @__PURE__ */ r.jsx(
        _e,
        {
          label: "Contrast Max",
          value: N.calMax ?? 100,
          onValueChange: p,
          min: N.globalMin ?? 0,
          max: N.globalMax ?? 255,
          step: 0.1,
          decimalPlaces: 1
        }
      ),
      /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
        /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Colormap" }),
        /* @__PURE__ */ r.jsx(
          It,
          {
            value: N.colormap || "gray",
            onChange: C,
            children: (O = e.current) == null ? void 0 : O.colormaps.map((M) => /* @__PURE__ */ r.jsx("option", { value: M, children: M }, M))
          }
        )
      ] })
    ] }) : /* @__PURE__ */ r.jsx("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground" }) })
  ] });
}
var ws = "Checkbox", [Cw] = an(ws), [ww, Uu] = Cw(ws);
function Aw(e) {
  const {
    __scopeCheckbox: t,
    checked: n,
    children: a,
    defaultChecked: l,
    disabled: i,
    form: o,
    name: s,
    onCheckedChange: c,
    required: u,
    value: m = "on",
    // @ts-expect-error
    internal_do_not_use_render: g
  } = e, [f, p] = qn({
    prop: n,
    defaultProp: l ?? !1,
    onChange: c,
    caller: ws
  }), [C, x] = v.useState(null), [S, h] = v.useState(null), d = v.useRef(!1), y = C ? !!o || !!C.closest("form") : (
    // We set this to true by default so that events bubble to forms without JS (SSR)
    !0
  ), b = {
    checked: f,
    disabled: i,
    setChecked: p,
    control: C,
    setControl: x,
    name: s,
    form: o,
    value: m,
    hasConsumerStoppedPropagationRef: d,
    required: u,
    defaultChecked: kn(l) ? !1 : l,
    isFormControl: y,
    bubbleInput: S,
    setBubbleInput: h
  };
  return /* @__PURE__ */ r.jsx(
    ww,
    {
      scope: t,
      ...b,
      children: Nw(g) ? g(b) : a
    }
  );
}
var Np = "CheckboxTrigger", Ep = v.forwardRef(
  ({ __scopeCheckbox: e, onKeyDown: t, onClick: n, ...a }, l) => {
    const {
      control: i,
      value: o,
      disabled: s,
      checked: c,
      required: u,
      setControl: m,
      setChecked: g,
      hasConsumerStoppedPropagationRef: f,
      isFormControl: p,
      bubbleInput: C
    } = Uu(Np, e), x = Ee(l, m), S = v.useRef(c);
    return v.useEffect(() => {
      const h = i == null ? void 0 : i.form;
      if (h) {
        const d = () => g(S.current);
        return h.addEventListener("reset", d), () => h.removeEventListener("reset", d);
      }
    }, [i, g]), /* @__PURE__ */ r.jsx(
      me.button,
      {
        type: "button",
        role: "checkbox",
        "aria-checked": kn(c) ? "mixed" : c,
        "aria-required": u,
        "data-state": Op(c),
        "data-disabled": s ? "" : void 0,
        disabled: s,
        value: o,
        ...a,
        ref: x,
        onKeyDown: ue(t, (h) => {
          h.key === "Enter" && h.preventDefault();
        }),
        onClick: ue(n, (h) => {
          g((d) => kn(d) ? !0 : !d), C && p && (f.current = h.isPropagationStopped(), f.current || h.stopPropagation());
        })
      }
    );
  }
);
Ep.displayName = Np;
var jp = v.forwardRef(
  (e, t) => {
    const {
      __scopeCheckbox: n,
      name: a,
      checked: l,
      defaultChecked: i,
      required: o,
      disabled: s,
      value: c,
      onCheckedChange: u,
      form: m,
      ...g
    } = e;
    return /* @__PURE__ */ r.jsx(
      Aw,
      {
        __scopeCheckbox: n,
        checked: l,
        defaultChecked: i,
        disabled: s,
        required: o,
        onCheckedChange: u,
        name: a,
        form: m,
        value: c,
        internal_do_not_use_render: ({ isFormControl: f }) => /* @__PURE__ */ r.jsxs(r.Fragment, { children: [
          /* @__PURE__ */ r.jsx(
            Ep,
            {
              ...g,
              ref: t,
              __scopeCheckbox: n
            }
          ),
          f && /* @__PURE__ */ r.jsx(
            _p,
            {
              __scopeCheckbox: n
            }
          )
        ] })
      }
    );
  }
);
jp.displayName = ws;
var Mp = "CheckboxIndicator", Tp = v.forwardRef(
  (e, t) => {
    const { __scopeCheckbox: n, forceMount: a, ...l } = e, i = Uu(Mp, n);
    return /* @__PURE__ */ r.jsx(
      Qn,
      {
        present: a || kn(i.checked) || i.checked === !0,
        children: /* @__PURE__ */ r.jsx(
          me.span,
          {
            "data-state": Op(i.checked),
            "data-disabled": i.disabled ? "" : void 0,
            ...l,
            ref: t,
            style: { pointerEvents: "none", ...e.style }
          }
        )
      }
    );
  }
);
Tp.displayName = Mp;
var Dp = "CheckboxBubbleInput", _p = v.forwardRef(
  ({ __scopeCheckbox: e, ...t }, n) => {
    const {
      control: a,
      hasConsumerStoppedPropagationRef: l,
      checked: i,
      defaultChecked: o,
      required: s,
      disabled: c,
      name: u,
      value: m,
      form: g,
      bubbleInput: f,
      setBubbleInput: p
    } = Uu(Dp, e), C = Ee(n, p), x = zu(i), S = Ru(a);
    v.useEffect(() => {
      const d = f;
      if (!d) return;
      const y = window.HTMLInputElement.prototype, N = Object.getOwnPropertyDescriptor(
        y,
        "checked"
      ).set, O = !l.current;
      if (x !== i && N) {
        const M = new Event("click", { bubbles: O });
        d.indeterminate = kn(i), N.call(d, kn(i) ? !1 : i), d.dispatchEvent(M);
      }
    }, [f, x, i, l]);
    const h = v.useRef(kn(i) ? !1 : i);
    return /* @__PURE__ */ r.jsx(
      me.input,
      {
        type: "checkbox",
        "aria-hidden": !0,
        defaultChecked: o ?? h.current,
        required: s,
        disabled: c,
        name: u,
        value: m,
        form: g,
        ...t,
        tabIndex: -1,
        ref: C,
        style: {
          ...t.style,
          ...S,
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
_p.displayName = Dp;
function Nw(e) {
  return typeof e == "function";
}
function kn(e) {
  return e === "indeterminate";
}
function Op(e) {
  return kn(e) ? "indeterminate" : e ? "checked" : "unchecked";
}
function Ve({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ r.jsx(
    jp,
    {
      "data-slot": "checkbox",
      className: te(
        "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ...t,
      children: /* @__PURE__ */ r.jsx(
        Tp,
        {
          "data-slot": "checkbox-indicator",
          className: "flex items-center justify-center text-current transition-none",
          children: /* @__PURE__ */ r.jsx(uS, { className: "size-3.5" })
        }
      )
    }
  );
}
function Ew({
  nvRef: e,
  onToggleVisibility: t,
  onRemoveSurface: n,
  onAddSurfaceFiles: a,
  onOpacityChange: l,
  onColorChange: i,
  onShaderChange: o,
  getLayers: s,
  onAddLayerFiles: c,
  onRemoveLayer: u,
  onLayerOpacityChange: m,
  onLayerCalMinChange: g,
  onLayerCalMaxChange: f,
  onLayerColormapChange: p,
  onLayerUseNegativeCmapChange: C
}) {
  var O, M, A, w, E, R;
  const x = T((k) => k.surfaces), S = T((k) => k.currentSurfaceIndex), h = T(
    (k) => k.setCurrentSurfaceIndex
  ), d = T((k) => k.selectedLayerIndex), y = T(
    (k) => k.setSelectedLayerIndex
  ), b = s(), N = d !== null ? b[d] : null;
  return /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ r.jsxs("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ r.jsx("h2", { className: "text-lg font-semibold", children: "Surface Details" }),
      /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground", children: "Manage surfaces and adjust properties" })
    ] }),
    /* @__PURE__ */ r.jsxs(Hn, { className: "max-h-[50%] min-h-0", children: [
      x.length > 0 ? /* @__PURE__ */ r.jsx("div", { className: "grid gap-2 p-4", children: x.map((k, V) => /* @__PURE__ */ r.jsxs(
        "div",
        {
          className: te(
            "flex items-center gap-2 p-2 rounded-md cursor-pointer",
            S === V ? "bg-muted" : "hover:bg-muted/50"
          ),
          onClick: () => h(V),
          children: [
            /* @__PURE__ */ r.jsx("div", { className: "flex-shrink-0", children: /* @__PURE__ */ r.jsx(
              q,
              {
                variant: "ghost",
                size: "sm",
                className: "h-6 w-6 p-0",
                onClick: (J) => {
                  J.stopPropagation(), t(V);
                },
                children: k.visible ? /* @__PURE__ */ r.jsx(wu, { className: "h-3 w-3" }) : /* @__PURE__ */ r.jsx(Cu, { className: "h-3 w-3 opacity-50" })
              }
            ) }),
            /* @__PURE__ */ r.jsx("div", { className: "flex-1 w-0", children: /* @__PURE__ */ r.jsx("p", { className: "text-sm font-medium break-words", children: k.name }) }),
            /* @__PURE__ */ r.jsx("div", { className: "flex-shrink-0 flex gap-1", children: /* @__PURE__ */ r.jsx(
              q,
              {
                variant: "ghost",
                size: "sm",
                className: "h-6 w-6 p-0 hover:bg-destructive hover:text-destructive-foreground",
                onClick: (J) => {
                  J.stopPropagation(), n(V);
                },
                title: "Delete surface",
                children: /* @__PURE__ */ r.jsx(Fo, { className: "h-3 w-3" })
              }
            ) })
          ]
        },
        k.id
      )) }) : /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground", children: [
        /* @__PURE__ */ r.jsx(ps, { className: "h-8 w-8 mb-2" }),
        /* @__PURE__ */ r.jsx("p", { children: "No surfaces" })
      ] }),
      /* @__PURE__ */ r.jsx("div", { className: "p-2 border-t space-y-2", children: /* @__PURE__ */ r.jsxs(
        q,
        {
          variant: "outline",
          size: "sm",
          className: "w-full",
          onClick: a,
          children: [
            /* @__PURE__ */ r.jsx(fi, { className: "mr-2 h-4 w-4" }),
            "Load surfaces"
          ]
        }
      ) })
    ] }),
    /* @__PURE__ */ r.jsx(Hn, { className: "flex-1 min-h-0", children: S != null && x[S] ? /* @__PURE__ */ r.jsxs("div", { className: "grid gap-4 p-4", children: [
      /* @__PURE__ */ r.jsx(
        _e,
        {
          label: "Opacity",
          value: ((O = x[S]) == null ? void 0 : O.opacity) || 1,
          onValueChange: l,
          min: 0,
          max: 1,
          step: 0.01
        }
      ),
      /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
        /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Color" }),
        /* @__PURE__ */ r.jsxs("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ r.jsx(
            "input",
            {
              type: "color",
              value: hd(
                ((M = x[S]) == null ? void 0 : M.rgba255) || [
                  255,
                  255,
                  0,
                  255
                ]
              ),
              onChange: (k) => i(k.target.value),
              className: "h-9 w-16 rounded-md border border-input cursor-pointer"
            }
          ),
          /* @__PURE__ */ r.jsx("span", { className: "text-sm text-muted-foreground", children: hd(
            ((A = x[S]) == null ? void 0 : A.rgba255) || [
              255,
              255,
              0,
              255
            ]
          ) })
        ] })
      ] }),
      /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
        /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Mesh Shader" }),
        /* @__PURE__ */ r.jsx(
          It,
          {
            value: ((w = x[S]) == null ? void 0 : w.shaderType) || "phong",
            onChange: (k) => o(k.target.value),
            children: (E = e.current) == null ? void 0 : E.meshShaders.map((k) => /* @__PURE__ */ r.jsx("option", { value: k, children: k }, k))
          }
        )
      ] }),
      /* @__PURE__ */ r.jsxs("div", { className: "border-t pt-4", children: [
        /* @__PURE__ */ r.jsxs("div", { className: "flex items-center justify-between mb-2", children: [
          /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Layers" }),
          /* @__PURE__ */ r.jsxs(q, { variant: "outline", size: "sm", onClick: c, children: [
            /* @__PURE__ */ r.jsx(fi, { className: "mr-2 h-3 w-3" }),
            "Add"
          ] })
        ] }),
        b.length > 0 ? /* @__PURE__ */ r.jsx("div", { className: "grid gap-1 mb-4", children: b.map((k, V) => /* @__PURE__ */ r.jsxs(
          "div",
          {
            className: te(
              "flex items-center gap-2 p-2 rounded-md cursor-pointer text-sm",
              d === V ? "bg-muted" : "hover:bg-muted/50"
            ),
            onClick: () => y(V),
            children: [
              /* @__PURE__ */ r.jsx("div", { className: "flex-1 w-0", children: /* @__PURE__ */ r.jsx("p", { className: "text-sm truncate", children: k.name || `Layer ${V + 1}` }) }),
              /* @__PURE__ */ r.jsx(
                q,
                {
                  variant: "ghost",
                  size: "sm",
                  className: "h-6 w-6 p-0 hover:bg-destructive hover:text-destructive-foreground",
                  onClick: (J) => {
                    J.stopPropagation(), u(V);
                  },
                  title: "Remove layer",
                  children: /* @__PURE__ */ r.jsx(Fo, { className: "h-3 w-3" })
                }
              )
            ]
          },
          V
        )) }) : /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground mb-4", children: "No layers loaded" }),
        N && /* @__PURE__ */ r.jsxs("div", { className: "grid gap-4 border-t pt-4", children: [
          /* @__PURE__ */ r.jsx(
            _e,
            {
              label: "Contrast Min",
              value: N.calMin ?? 0,
              onValueChange: g,
              min: -10,
              max: 10,
              step: 0.01
            }
          ),
          /* @__PURE__ */ r.jsx(
            _e,
            {
              label: "Contrast Max",
              value: N.calMax ?? 1,
              onValueChange: f,
              min: -10,
              max: 10,
              step: 0.01
            }
          ),
          /* @__PURE__ */ r.jsx(
            _e,
            {
              label: "Opacity",
              value: N.opacity ?? 1,
              onValueChange: m,
              min: 0,
              max: 1,
              step: 0.01
            }
          ),
          /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
            /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Colormap" }),
            /* @__PURE__ */ r.jsx(
              It,
              {
                value: N.colormap || "warm",
                onChange: (k) => p(k.target.value),
                children: (R = e.current) == null ? void 0 : R.colormaps.map((k) => /* @__PURE__ */ r.jsx("option", { value: k, children: k }, k))
              }
            )
          ] }),
          /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
            /* @__PURE__ */ r.jsx(
              Ve,
              {
                id: "use-negative-cmap",
                checked: !!N.colormapNegative,
                onCheckedChange: (k) => C(k === !0)
              }
            ),
            /* @__PURE__ */ r.jsx(
              F,
              {
                htmlFor: "use-negative-cmap",
                className: "text-sm font-medium",
                children: "Use Negative Colormap"
              }
            )
          ] })
        ] })
      ] })
    ] }) : /* @__PURE__ */ r.jsx("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground" }) })
  ] });
}
function jw({
  nvRef: e,
  onDrawModeChange: t,
  onDrawingColormapChange: n,
  onPenFillChange: a,
  onPenErasesChange: l,
  onPenValueChange: i,
  onDrawingOpacityChange: o,
  onMagicWand2dOnlyChange: s,
  onMagicWandMaxDistanceChange: c,
  onMagicWandThresholdChange: u,
  onDrawUndo: m,
  onSaveDrawing: g
}) {
  var x;
  const f = T((S) => S.drawingOptions), p = T((S) => S.setDrawingOptions), C = ((x = e.current) == null ? void 0 : x.drawingColormaps) ?? [];
  return /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ r.jsxs("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ r.jsx("h2", { className: "text-lg font-semibold", children: "Drawing Tools" }),
      /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground", children: "Edit annotations" })
    ] }),
    /* @__PURE__ */ r.jsx(Hn, { className: "flex-1 min-h-0", children: /* @__PURE__ */ r.jsx("div", { className: "p-4 space-y-4", children: f.enabled ? /* @__PURE__ */ r.jsxs(r.Fragment, { children: [
      /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
        /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Filename" }),
        /* @__PURE__ */ r.jsx(
          ca,
          {
            type: "text",
            value: f.filename,
            onChange: (S) => p((h) => ({
              ...h,
              filename: S.target.value
            })),
            placeholder: "Enter filename..."
          }
        )
      ] }),
      /* @__PURE__ */ r.jsx(
        _e,
        {
          label: "Drawing Opacity",
          value: f.opacity,
          onValueChange: o,
          min: 0,
          max: 1,
          step: 0.01
        }
      ),
      /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
        /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Drawing Colormap" }),
        /* @__PURE__ */ r.jsx(
          It,
          {
            value: f.colormap,
            onChange: n,
            children: C.map((S) => /* @__PURE__ */ r.jsx("option", { value: S, children: S }, S))
          }
        )
      ] }),
      /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
        /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Draw Mode" }),
        /* @__PURE__ */ r.jsxs(
          It,
          {
            value: f.mode,
            onChange: (S) => t(S.target.value),
            children: [
              /* @__PURE__ */ r.jsx("option", { value: "none", children: "None" }),
              /* @__PURE__ */ r.jsx("option", { value: "pen", children: "Pen" }),
              /* @__PURE__ */ r.jsx("option", { value: "wand", children: "Magic Wand" })
            ]
          }
        )
      ] }),
      (f.mode === "pen" || f.mode === "wand") && /* @__PURE__ */ r.jsxs(
        q,
        {
          variant: "outline",
          size: "sm",
          className: "w-full",
          onClick: m,
          children: [
            /* @__PURE__ */ r.jsx(bv, { className: "mr-2 h-4 w-4" }),
            "Undo"
          ]
        }
      ),
      (f.mode === "pen" || f.mode === "wand") && /* @__PURE__ */ r.jsxs(r.Fragment, { children: [
        f.mode === "pen" && /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
          /* @__PURE__ */ r.jsx(
            Ve,
            {
              id: "pen-fill",
              checked: f.penFill,
              onCheckedChange: a
            }
          ),
          /* @__PURE__ */ r.jsx(F, { htmlFor: "pen-fill", className: "text-sm font-medium", children: "Pen Fill" })
        ] }),
        f.mode === "pen" && /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
          /* @__PURE__ */ r.jsx(
            Ve,
            {
              id: "pen-erases",
              checked: f.penErases,
              onCheckedChange: l
            }
          ),
          /* @__PURE__ */ r.jsx(
            F,
            {
              htmlFor: "pen-erases",
              className: "text-sm font-medium",
              children: "Pen Erases"
            }
          )
        ] }),
        f.mode === "wand" && /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
          /* @__PURE__ */ r.jsx(
            Ve,
            {
              id: "magic-wand-2d-only",
              checked: f.magicWand2dOnly,
              onCheckedChange: s
            }
          ),
          /* @__PURE__ */ r.jsx(
            F,
            {
              htmlFor: "magic-wand-2d-only",
              className: "text-sm font-medium",
              children: "2D Only"
            }
          )
        ] }),
        f.mode === "wand" && /* @__PURE__ */ r.jsx(
          _e,
          {
            label: "Max Distance (mm)",
            value: f.magicWandMaxDistanceMM,
            onValueChange: c,
            min: 2,
            max: 500,
            step: 1
          }
        ),
        f.mode === "wand" && /* @__PURE__ */ r.jsx(
          _e,
          {
            label: "Threshold Percentage",
            value: f.magicWandThresholdPercent,
            onValueChange: u,
            min: 0,
            max: 1,
            step: 0.01
          }
        ),
        /* @__PURE__ */ r.jsx(
          _e,
          {
            label: "Pen Value",
            value: f.penValue,
            onValueChange: i,
            min: 1,
            max: 255,
            step: 1,
            disabled: f.penErases
          }
        )
      ] }),
      /* @__PURE__ */ r.jsxs(
        q,
        {
          variant: "outline",
          size: "sm",
          className: "w-full",
          onClick: g,
          children: [
            /* @__PURE__ */ r.jsx(yv, { className: "mr-2 h-4 w-4" }),
            "Save Drawing"
          ]
        }
      )
    ] }) : /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground", children: [
      /* @__PURE__ */ r.jsx(Au, { className: "h-8 w-8 mb-2" }),
      /* @__PURE__ */ r.jsx("p", { children: "No drawing layer active" }),
      /* @__PURE__ */ r.jsx("p", { className: "text-xs", children: "Create a drawing layer to access drawing tools" })
    ] }) }) })
  ] });
}
const Mw = [
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
], Tw = [
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
function Gd(e) {
  return e[Math.floor(Math.random() * e.length)];
}
function Yd() {
  return `${Gd(Mw)}${Gd(Tw)}`;
}
function Dw({
  volumesCount: e,
  onNewSession: t,
  onLoadSession: n,
  onRunSegmentation: a,
  onExitAndSaveSession: l,
  onExitAndDeleteSession: i,
  onRefreshSessions: o,
  onDrawModeChange: s,
  onDrawingOpacityChange: c,
  onPenValueChange: u,
  onPenFillChange: m,
  onPenErasesChange: g,
  onMagicWand2dOnlyChange: f,
  onMagicWandMaxDistanceChange: p,
  onMagicWandThresholdChange: C,
  onDrawUndo: x
}) {
  const S = T((H) => H.aiSessions), h = T((H) => H.aiActiveSession), d = T((H) => H.drawingOptions), [y, b] = v.useState(() => Yd()), [N, O] = v.useState(""), [M, A] = v.useState(null), [w, E] = v.useState(!1), [R, k] = v.useState([]), [V, J] = v.useState(""), [z, j] = v.useState(1), [U, D] = v.useState(!1), [Q, I] = v.useState(null), [Be, we] = v.useState(!1);
  v.useEffect(() => {
    o();
  }, [o]);
  const ie = v.useCallback(async () => {
    try {
      const H = await fetch(Nn("model/list"));
      if (!H.ok) throw new Error(`GET /ai/model/list failed: ${H.status}`);
      const Rt = await H.json();
      k(Rt), J(
        (Cl) => {
          var Mi;
          return Cl && Rt.some((Es) => Es.ml_id === Cl) ? Cl : ((Mi = Rt[0]) == null ? void 0 : Mi.ml_id) ?? "";
        }
      );
    } catch (H) {
      console.error(H);
    }
  }, []);
  v.useEffect(() => {
    ie();
  }, [ie]);
  const ne = v.useMemo(() => {
    const H = {};
    for (const Rt of S) H[Rt.session_id] = Rt;
    return H;
  }, [S]), Qe = async () => {
    A(null), E(!0);
    try {
      await t(y);
    } catch (H) {
      A(H instanceof Error ? H.message : String(H)), b(Yd());
    } finally {
      E(!1);
    }
  }, ln = async () => {
    if (N) {
      E(!0);
      try {
        await n(N);
      } catch (H) {
        console.error("Load Session failed:", H), A(H instanceof Error ? H.message : String(H));
      } finally {
        E(!1);
      }
    }
  }, ye = () => {
    ie();
  }, ga = async () => {
    if (!(!h || !V)) {
      I(null), D(!0);
      try {
        await a(V, z);
      } catch (H) {
        I(H instanceof Error ? H.message : String(H));
      } finally {
        D(!1);
      }
    }
  }, on = async () => {
    I(null), we(!0);
    try {
      await l();
    } catch (H) {
      I(H instanceof Error ? H.message : String(H));
    } finally {
      we(!1);
    }
  }, sn = async () => {
    I(null), we(!0);
    try {
      await i();
    } catch (H) {
      I(H instanceof Error ? H.message : String(H));
    } finally {
      we(!1);
    }
  }, rn = (H) => {
    u(H === "positive" ? 1 : 2), d.mode !== "pen" && s("pen");
  }, cn = () => /* @__PURE__ */ r.jsxs("div", { className: "p-4 space-y-6", children: [
    /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
      /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Session Name" }),
      /* @__PURE__ */ r.jsx(
        ca,
        {
          type: "text",
          value: y,
          onChange: (H) => b(H.target.value),
          placeholder: "Enter session name..."
        }
      ),
      /* @__PURE__ */ r.jsx(
        q,
        {
          className: "w-full",
          onClick: Qe,
          disabled: e === 0 || w,
          children: "New Session"
        }
      ),
      e === 0 && /* @__PURE__ */ r.jsx("p", { className: "text-xs text-muted-foreground", children: "Load a volume before creating a session." }),
      M && /* @__PURE__ */ r.jsx("p", { className: "text-xs text-destructive", children: M })
    ] }),
    /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
      /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Previous Sessions" }),
      /* @__PURE__ */ r.jsxs(
        It,
        {
          value: N,
          onChange: (H) => O(H.target.value),
          disabled: S.length === 0 || w,
          children: [
            /* @__PURE__ */ r.jsx("option", { value: "", children: S.length === 0 ? "(no sessions)" : "Select a session..." }),
            S.map((H) => /* @__PURE__ */ r.jsx("option", { value: H.session_id, children: H.session_name }, H.session_id))
          ]
        }
      ),
      /* @__PURE__ */ r.jsx(
        q,
        {
          variant: "outline",
          className: "w-full",
          onClick: ln,
          disabled: !N || w,
          children: "Load Session"
        }
      ),
      N && ne[N] && /* @__PURE__ */ r.jsxs("p", { className: "text-xs text-muted-foreground", children: [
        "volume: ",
        ne[N].volume_path ?? "—",
        /* @__PURE__ */ r.jsx("br", {}),
        "annotations:",
        " ",
        ne[N].annotation_path ?? "—"
      ] })
    ] })
  ] }), Ns = () => h ? /* @__PURE__ */ r.jsxs("div", { className: "p-4 space-y-4", children: [
    /* @__PURE__ */ r.jsxs("div", { className: "space-y-1", children: [
      /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Session" }),
      /* @__PURE__ */ r.jsxs("p", { className: "text-sm", children: [
        h.session_name,
        " ",
        /* @__PURE__ */ r.jsxs("span", { className: "text-xs text-muted-foreground", children: [
          "(",
          h.session_id.slice(0, 8),
          "…)"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ r.jsxs(
      q,
      {
        variant: "outline",
        size: "sm",
        className: "w-full",
        onClick: () => void on(),
        disabled: U || Be,
        children: [
          /* @__PURE__ */ r.jsx(LS, { className: "mr-2 h-4 w-4" }),
          "Exit and Save Session"
        ]
      }
    ),
    /* @__PURE__ */ r.jsxs(
      q,
      {
        variant: "destructive",
        size: "sm",
        className: "w-full",
        onClick: () => void sn(),
        disabled: U || Be,
        children: [
          /* @__PURE__ */ r.jsx(Fo, { className: "mr-2 h-4 w-4" }),
          "Exit and Delete Session"
        ]
      }
    ),
    /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
      /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Select AI model" }),
      /* @__PURE__ */ r.jsx(
        It,
        {
          value: V,
          onChange: (H) => J(H.target.value),
          children: R.length === 0 ? /* @__PURE__ */ r.jsx("option", { value: "", children: "(no models available)" }) : R.map((H) => /* @__PURE__ */ r.jsx("option", { value: H.ml_id, children: H.name }, H.ml_id))
        }
      ),
      /* @__PURE__ */ r.jsx(q, { variant: "outline", className: "w-full", onClick: ye, children: "Reload Models" })
    ] }),
    /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
      /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Draw Mode" }),
      /* @__PURE__ */ r.jsxs(
        It,
        {
          value: d.mode,
          onChange: (H) => s(H.target.value),
          children: [
            /* @__PURE__ */ r.jsx("option", { value: "none", children: "None" }),
            /* @__PURE__ */ r.jsx("option", { value: "pen", children: "Pen" }),
            /* @__PURE__ */ r.jsx("option", { value: "wand", children: "Magic Wand" })
          ]
        }
      )
    ] }),
    /* @__PURE__ */ r.jsx(
      _e,
      {
        label: "Drawing Opacity",
        value: d.opacity,
        onValueChange: c,
        min: 0,
        max: 1,
        step: 0.01
      }
    ),
    (d.mode === "pen" || d.mode === "wand") && /* @__PURE__ */ r.jsxs(
      q,
      {
        variant: "outline",
        size: "sm",
        className: "w-full",
        onClick: x,
        children: [
          /* @__PURE__ */ r.jsx(bv, { className: "mr-2 h-4 w-4" }),
          "Undo"
        ]
      }
    ),
    d.mode === "pen" && /* @__PURE__ */ r.jsxs(r.Fragment, { children: [
      /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
        /* @__PURE__ */ r.jsx(
          Ve,
          {
            id: "ai-pen-fill",
            checked: d.penFill,
            onCheckedChange: m
          }
        ),
        /* @__PURE__ */ r.jsx(F, { htmlFor: "ai-pen-fill", className: "text-sm font-medium", children: "Pen Fill" })
      ] }),
      /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
        /* @__PURE__ */ r.jsx(
          Ve,
          {
            id: "ai-pen-erases",
            checked: d.penErases,
            onCheckedChange: g
          }
        ),
        /* @__PURE__ */ r.jsx(F, { htmlFor: "ai-pen-erases", className: "text-sm font-medium", children: "Pen Erases" })
      ] })
    ] }),
    d.mode === "wand" && /* @__PURE__ */ r.jsxs(r.Fragment, { children: [
      /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
        /* @__PURE__ */ r.jsx(
          Ve,
          {
            id: "ai-magic-wand-2d-only",
            checked: d.magicWand2dOnly,
            onCheckedChange: f
          }
        ),
        /* @__PURE__ */ r.jsx(
          F,
          {
            htmlFor: "ai-magic-wand-2d-only",
            className: "text-sm font-medium",
            children: "2D Only"
          }
        )
      ] }),
      /* @__PURE__ */ r.jsx(
        _e,
        {
          label: "Max Distance (mm)",
          value: d.magicWandMaxDistanceMM,
          onValueChange: p,
          min: 2,
          max: 500,
          step: 1
        }
      ),
      /* @__PURE__ */ r.jsx(
        _e,
        {
          label: "Threshold Percentage",
          value: d.magicWandThresholdPercent,
          onValueChange: C,
          min: 0,
          max: 1,
          step: 0.01
        }
      )
    ] }),
    /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
      /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Click Mode" }),
      /* @__PURE__ */ r.jsxs("div", { className: "flex gap-2", children: [
        /* @__PURE__ */ r.jsx(
          q,
          {
            variant: d.penValue === 1 ? "default" : "outline",
            size: "sm",
            className: "flex-1",
            onClick: () => rn("positive"),
            children: "+ Positive"
          }
        ),
        /* @__PURE__ */ r.jsx(
          q,
          {
            variant: d.penValue === 2 ? "default" : "outline",
            size: "sm",
            className: "flex-1",
            onClick: () => rn("negative"),
            children: "− Negative"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ r.jsx(
      _e,
      {
        label: "Result label value",
        value: z,
        onValueChange: j,
        min: 0,
        max: 255,
        step: 1,
        decimalPlaces: 0
      }
    ),
    /* @__PURE__ */ r.jsx("p", { className: "text-xs text-muted-foreground -mt-2", children: "Foreground voxel value in the returned mask." }),
    /* @__PURE__ */ r.jsxs(
      q,
      {
        className: "w-full",
        onClick: () => void ga(),
        disabled: !V || U || Be,
        children: [
          /* @__PURE__ */ r.jsx(ps, { className: "mr-2 h-4 w-4" }),
          U ? "Running segmentation…" : "Run Segmentation"
        ]
      }
    ),
    Q && /* @__PURE__ */ r.jsx("p", { className: "text-xs text-destructive", children: Q })
  ] }) : null;
  return /* @__PURE__ */ r.jsxs("div", { className: "flex flex-col h-full", children: [
    /* @__PURE__ */ r.jsxs("div", { className: "border-b px-4 py-3", children: [
      /* @__PURE__ */ r.jsx("h2", { className: "text-lg font-semibold", children: "AI annotation (experimental)" }),
      /* @__PURE__ */ r.jsx("p", { className: "text-sm text-muted-foreground", children: "Guide an AI model with positive and negative seed voxels." })
    ] }),
    /* @__PURE__ */ r.jsx(Hn, { className: "flex-1 min-h-0", children: h ? Ns() : cn() })
  ] });
}
function _w(e) {
  const t = T((o) => o.activeTab), n = T((o) => o.setActiveTab), a = T((o) => o.drawingOptions), l = T((o) => o.aiEnabled), i = !e.serverlessMode && l === !0;
  return /* @__PURE__ */ r.jsx(
    "aside",
    {
      className: te(
        "border-l bg-background w-80 overflow-hidden flex flex-col"
      ),
      children: /* @__PURE__ */ r.jsxs(
        OC,
        {
          value: t,
          onValueChange: n,
          className: "flex flex-col flex-1 min-h-0",
          children: [
            /* @__PURE__ */ r.jsxs(zC, { className: "w-full justify-start border-b rounded-none px-2 h-12 flex-shrink-0", children: [
              /* @__PURE__ */ r.jsx(
                xa,
                {
                  value: "sceneDetails",
                  className: "data-[state=active]:bg-muted",
                  children: /* @__PURE__ */ r.jsx(pv, { className: "h-4 w-4 mr-2" })
                }
              ),
              /* @__PURE__ */ r.jsx(
                xa,
                {
                  value: "surfaceDetails",
                  className: "data-[state=active]:bg-muted",
                  children: /* @__PURE__ */ r.jsx(ps, { className: "h-4 w-4 mr-2" })
                }
              ),
              /* @__PURE__ */ r.jsx(
                xa,
                {
                  value: "drawing",
                  className: te(
                    "data-[state=active]:bg-muted",
                    !a.enabled && "text-muted-foreground"
                  ),
                  disabled: !a.enabled,
                  children: /* @__PURE__ */ r.jsx(Au, { className: "h-4 w-4 mr-2" })
                }
              ),
              i && /* @__PURE__ */ r.jsx(
                xa,
                {
                  value: "aiAnnotation",
                  className: "data-[state=active]:bg-muted",
                  children: /* @__PURE__ */ r.jsx(s2, { className: "h-4 w-4 mr-2" })
                }
              ),
              !e.serverlessMode && /* @__PURE__ */ r.jsx(xa, { value: "nvds", className: "data-[state=active]:bg-muted", children: /* @__PURE__ */ r.jsx(DS, { className: "h-4 w-4 mr-2" }) }),
              !e.serverlessMode && /* @__PURE__ */ r.jsx(xa, { value: "data", className: "data-[state=active]:bg-muted", children: /* @__PURE__ */ r.jsx(AS, { className: "h-4 w-4 mr-2" }) })
            ] }),
            /* @__PURE__ */ r.jsx(Sa, { value: "sceneDetails", className: "flex-1 min-h-0 p-0", children: /* @__PURE__ */ r.jsx(
              Sw,
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
            /* @__PURE__ */ r.jsx(Sa, { value: "surfaceDetails", className: "flex-1 min-h-0 p-0", children: /* @__PURE__ */ r.jsx(
              Ew,
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
            /* @__PURE__ */ r.jsx(Sa, { value: "drawing", className: "flex-1 min-h-0 p-0", children: /* @__PURE__ */ r.jsx(
              jw,
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
            i && /* @__PURE__ */ r.jsx(Sa, { value: "aiAnnotation", className: "flex-1 min-h-0 p-0", children: /* @__PURE__ */ r.jsx(
              Dw,
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
            /* @__PURE__ */ r.jsx(Sa, { value: "nvds", className: "flex-1 min-h-0 p-0", children: !e.serverlessMode && /* @__PURE__ */ r.jsx(JC, { onFileSelect: e.onNvdFileSelect }) }),
            /* @__PURE__ */ r.jsx(Sa, { value: "data", className: "flex-1 min-h-0 p-0", children: !e.serverlessMode && /* @__PURE__ */ r.jsx(IC, { onFileSelect: e.onImagingFileSelect }) })
          ]
        }
      )
    }
  );
}
const Ni = ({ open: e = !1, onOpenChange: t, children: n }) => (v.useEffect(() => {
  const a = (l) => {
    l.key === "Escape" && e && (t == null || t(!1));
  };
  return e && document.addEventListener("keydown", a), () => {
    document.removeEventListener("keydown", a);
  };
}, [e, t]), e ? /* @__PURE__ */ r.jsxs("div", { className: "absolute inset-0 z-50 flex items-center justify-center", children: [
  /* @__PURE__ */ r.jsx(
    "div",
    {
      className: "absolute inset-0 bg-black/50",
      onClick: () => t == null ? void 0 : t(!1)
    }
  ),
  /* @__PURE__ */ r.jsx("div", { className: "relative", children: n })
] }) : null), bl = v.forwardRef(({ className: e, children: t, onClose: n, ...a }, l) => /* @__PURE__ */ r.jsxs(
  "div",
  {
    ref: l,
    className: te(
      "relative bg-background border rounded-lg shadow-lg p-6 w-full max-w-lg mx-4",
      "animate-in fade-in-0 zoom-in-95",
      e
    ),
    ...a,
    children: [
      n && /* @__PURE__ */ r.jsx(
        "button",
        {
          onClick: n,
          className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
          children: /* @__PURE__ */ r.jsx(y2, { className: "h-4 w-4" })
        }
      ),
      t
    ]
  }
));
bl.displayName = "DialogContent";
const Ei = ({
  className: e,
  ...t
}) => /* @__PURE__ */ r.jsx(
  "div",
  {
    className: te("flex flex-col space-y-1.5 text-center sm:text-left mb-4", e),
    ...t
  }
), xl = v.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ r.jsx(
  "h2",
  {
    ref: n,
    className: te("text-lg font-semibold leading-none tracking-tight", e),
    ...t
  }
));
xl.displayName = "DialogTitle";
const Sl = v.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ r.jsx(
  "p",
  {
    ref: n,
    className: te("text-sm text-muted-foreground", e),
    ...t
  }
));
Sl.displayName = "DialogDescription";
const ji = ({
  className: e,
  ...t
}) => /* @__PURE__ */ r.jsx(
  "div",
  {
    className: te("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-6", e),
    ...t
  }
);
function Ow({ onConfirm: e, onCancel: t }) {
  const n = T((s) => s.removeDialogOpen), a = T((s) => s.setRemoveDialogOpen), l = T((s) => s.skipRemoveConfirmation), i = T((s) => s.setSkipRemoveConfirmation), o = T((s) => s.surfaceToRemove);
  return /* @__PURE__ */ r.jsx(Ni, { open: n, onOpenChange: a, children: /* @__PURE__ */ r.jsxs(bl, { onClose: t, children: [
    /* @__PURE__ */ r.jsxs(Ei, { children: [
      /* @__PURE__ */ r.jsx(xl, { children: o !== null ? "Remove Surface" : "Remove Volume" }),
      /* @__PURE__ */ r.jsxs(Sl, { children: [
        "Are you sure you want to remove this ",
        o !== null ? "surface" : "volume",
        "?"
      ] })
    ] }),
    /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2 mt-4", children: [
      /* @__PURE__ */ r.jsx(
        Ve,
        {
          id: "dont-ask-again",
          checked: l,
          onCheckedChange: (s) => i(s === !0)
        }
      ),
      /* @__PURE__ */ r.jsx(F, { htmlFor: "dont-ask-again", className: "text-sm", children: "Don't ask me again" })
    ] }),
    /* @__PURE__ */ r.jsxs(ji, { children: [
      /* @__PURE__ */ r.jsx(q, { variant: "outline", onClick: t, children: "Cancel" }),
      /* @__PURE__ */ r.jsx(q, { variant: "destructive", onClick: e, children: "Remove" })
    ] })
  ] }) });
}
var Vu = "Radio", [zw, zp] = an(Vu), [Rw, kw] = zw(Vu), Rp = v.forwardRef(
  (e, t) => {
    const {
      __scopeRadio: n,
      name: a,
      checked: l = !1,
      required: i,
      disabled: o,
      value: s = "on",
      onCheck: c,
      form: u,
      ...m
    } = e, [g, f] = v.useState(null), p = Ee(t, (S) => f(S)), C = v.useRef(!1), x = g ? u || !!g.closest("form") : !0;
    return /* @__PURE__ */ r.jsxs(Rw, { scope: n, checked: l, disabled: o, children: [
      /* @__PURE__ */ r.jsx(
        me.button,
        {
          type: "button",
          role: "radio",
          "aria-checked": l,
          "data-state": Lp(l),
          "data-disabled": o ? "" : void 0,
          disabled: o,
          value: s,
          ...m,
          ref: p,
          onClick: ue(e.onClick, (S) => {
            l || c == null || c(), x && (C.current = S.isPropagationStopped(), C.current || S.stopPropagation());
          })
        }
      ),
      x && /* @__PURE__ */ r.jsx(
        Vp,
        {
          control: g,
          bubbles: !C.current,
          name: a,
          value: s,
          checked: l,
          required: i,
          disabled: o,
          form: u,
          style: { transform: "translateX(-100%)" }
        }
      )
    ] });
  }
);
Rp.displayName = Vu;
var kp = "RadioIndicator", Up = v.forwardRef(
  (e, t) => {
    const { __scopeRadio: n, forceMount: a, ...l } = e, i = kw(kp, n);
    return /* @__PURE__ */ r.jsx(Qn, { present: a || i.checked, children: /* @__PURE__ */ r.jsx(
      me.span,
      {
        "data-state": Lp(i.checked),
        "data-disabled": i.disabled ? "" : void 0,
        ...l,
        ref: t
      }
    ) });
  }
);
Up.displayName = kp;
var Uw = "RadioBubbleInput", Vp = v.forwardRef(
  ({
    __scopeRadio: e,
    control: t,
    checked: n,
    bubbles: a = !0,
    ...l
  }, i) => {
    const o = v.useRef(null), s = Ee(o, i), c = zu(n), u = Ru(t);
    return v.useEffect(() => {
      const m = o.current;
      if (!m) return;
      const g = window.HTMLInputElement.prototype, p = Object.getOwnPropertyDescriptor(
        g,
        "checked"
      ).set;
      if (c !== n && p) {
        const C = new Event("click", { bubbles: a });
        p.call(m, n), m.dispatchEvent(C);
      }
    }, [c, n, a]), /* @__PURE__ */ r.jsx(
      me.input,
      {
        type: "radio",
        "aria-hidden": !0,
        defaultChecked: n,
        ...l,
        tabIndex: -1,
        ref: s,
        style: {
          ...l.style,
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
Vp.displayName = Uw;
function Lp(e) {
  return e ? "checked" : "unchecked";
}
var Vw = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], As = "RadioGroup", [Lw] = an(As, [
  pl,
  zp
]), Bp = pl(), Hp = zp(), [Bw, Hw] = Lw(As), Gp = v.forwardRef(
  (e, t) => {
    const {
      __scopeRadioGroup: n,
      name: a,
      defaultValue: l,
      value: i,
      required: o = !1,
      disabled: s = !1,
      orientation: c,
      dir: u,
      loop: m = !0,
      onValueChange: g,
      ...f
    } = e, p = Bp(n), C = vl(u), [x, S] = qn({
      prop: i,
      defaultProp: l ?? null,
      onChange: g,
      caller: As
    });
    return /* @__PURE__ */ r.jsx(
      Bw,
      {
        scope: n,
        name: a,
        required: o,
        disabled: s,
        value: x,
        onValueChange: S,
        children: /* @__PURE__ */ r.jsx(
          Nu,
          {
            asChild: !0,
            ...p,
            orientation: c,
            dir: C,
            loop: m,
            children: /* @__PURE__ */ r.jsx(
              me.div,
              {
                role: "radiogroup",
                "aria-required": o,
                "aria-orientation": c,
                "data-disabled": s ? "" : void 0,
                dir: C,
                ...f,
                ref: t
              }
            )
          }
        )
      }
    );
  }
);
Gp.displayName = As;
var Yp = "RadioGroupItem", qp = v.forwardRef(
  (e, t) => {
    const { __scopeRadioGroup: n, disabled: a, ...l } = e, i = Hw(Yp, n), o = i.disabled || a, s = Bp(n), c = Hp(n), u = v.useRef(null), m = Ee(t, u), g = i.value === l.value, f = v.useRef(!1);
    return v.useEffect(() => {
      const p = (x) => {
        Vw.includes(x.key) && (f.current = !0);
      }, C = () => f.current = !1;
      return document.addEventListener("keydown", p), document.addEventListener("keyup", C), () => {
        document.removeEventListener("keydown", p), document.removeEventListener("keyup", C);
      };
    }, []), /* @__PURE__ */ r.jsx(
      Eu,
      {
        asChild: !0,
        ...s,
        focusable: !o,
        active: g,
        children: /* @__PURE__ */ r.jsx(
          Rp,
          {
            disabled: o,
            required: i.required,
            checked: g,
            ...c,
            ...l,
            name: i.name,
            ref: m,
            onCheck: () => i.onValueChange(l.value),
            onKeyDown: ue((p) => {
              p.key === "Enter" && p.preventDefault();
            }),
            onFocus: ue(l.onFocus, () => {
              var p;
              f.current && ((p = u.current) == null || p.click());
            })
          }
        )
      }
    );
  }
);
qp.displayName = Yp;
var Gw = "RadioGroupIndicator", Xp = v.forwardRef(
  (e, t) => {
    const { __scopeRadioGroup: n, ...a } = e, l = Hp(n);
    return /* @__PURE__ */ r.jsx(Up, { ...l, ...a, ref: t });
  }
);
Xp.displayName = Gw;
var Yw = Gp, qw = qp, Xw = Xp;
function Qw({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ r.jsx(
    Yw,
    {
      "data-slot": "radio-group",
      className: te("grid gap-3", e),
      ...t
    }
  );
}
function qd({
  className: e,
  ...t
}) {
  return /* @__PURE__ */ r.jsx(
    qw,
    {
      "data-slot": "radio-group-item",
      className: te(
        "border-input text-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 aspect-square size-4 shrink-0 rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ...t,
      children: /* @__PURE__ */ r.jsx(
        Xw,
        {
          "data-slot": "radio-group-indicator",
          className: "relative flex items-center justify-center",
          children: /* @__PURE__ */ r.jsx(yS, { className: "fill-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" })
        }
      )
    }
  );
}
function Zw({
  nvRef: e,
  onConfirm: t,
  onCancel: n,
  onVolumeUrlChange: a,
  onVolumeCheckboxChange: l,
  onDocumentLocationChange: i,
  onDocumentCheckboxChange: o,
  onDocumentFormatChange: s
}) {
  const c = T((g) => g.saveDialogOpen), u = T((g) => g.setSaveDialogOpen), m = T((g) => g.saveState);
  return /* @__PURE__ */ r.jsx(Ni, { open: c, onOpenChange: u, children: /* @__PURE__ */ r.jsxs(bl, { onClose: n, children: [
    /* @__PURE__ */ r.jsxs(Ei, { children: [
      /* @__PURE__ */ r.jsx(xl, { children: m.isDownloadMode ? "Download Scene" : "Save Scene" }),
      /* @__PURE__ */ r.jsx(Sl, { children: m.isDownloadMode ? "Select the files you want to download." : "Enter the location where you want to save the scene." })
    ] }),
    /* @__PURE__ */ r.jsx("div", { className: "mt-4", children: /* @__PURE__ */ r.jsxs("div", { className: "flex items-center gap-3 p-3 border rounded-md", children: [
      /* @__PURE__ */ r.jsx(
        Ve,
        {
          id: "document-checkbox",
          checked: m.document.enabled,
          onCheckedChange: o,
          disabled: !m.document.location.trim()
        }
      ),
      /* @__PURE__ */ r.jsxs("div", { className: "flex-1 min-w-0", children: [
        /* @__PURE__ */ r.jsx(
          F,
          {
            htmlFor: "document-checkbox",
            className: "text-sm font-medium",
            children: m.isDownloadMode ? "NiiVue Document Name" : "NiiVue Document Save Location"
          }
        ),
        /* @__PURE__ */ r.jsx(
          ca,
          {
            id: "save-location",
            type: "text",
            placeholder: m.isDownloadMode ? "Enter filename..." : "Enter file path...",
            value: m.document.location,
            onChange: (g) => i(g.target.value),
            className: "mt-1"
          }
        ),
        /* @__PURE__ */ r.jsxs("div", { className: "mt-3", children: [
          /* @__PURE__ */ r.jsx(F, { className: "text-xs font-medium text-muted-foreground", children: "Format" }),
          /* @__PURE__ */ r.jsxs(
            Qw,
            {
              value: m.document.format,
              onValueChange: (g) => s(g),
              className: "mt-1 flex gap-4",
              children: [
                /* @__PURE__ */ r.jsxs("div", { className: "flex items-center gap-2", children: [
                  /* @__PURE__ */ r.jsx(qd, { value: "json", id: "format-json" }),
                  /* @__PURE__ */ r.jsx(F, { htmlFor: "format-json", className: "text-sm font-normal", children: "JSON" })
                ] }),
                /* @__PURE__ */ r.jsxs("div", { className: "flex items-center gap-2", children: [
                  /* @__PURE__ */ r.jsx(
                    qd,
                    {
                      value: "cbor",
                      id: "format-cbor",
                      disabled: !m.isDownloadMode
                    }
                  ),
                  /* @__PURE__ */ r.jsx(
                    F,
                    {
                      htmlFor: "format-cbor",
                      className: "text-sm font-normal data-[disabled]:text-muted-foreground",
                      "data-disabled": !m.isDownloadMode || void 0,
                      children: "CBOR"
                    }
                  )
                ] })
              ]
            }
          ),
          !m.isDownloadMode && /* @__PURE__ */ r.jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "CBOR is download-only: saving to the server rewrites each volume’s URL to its upload destination, which needs the text format." })
        ] })
      ] })
    ] }) }),
    m.volumes.length > 0 && /* @__PURE__ */ r.jsxs("div", { className: "mt-4", children: [
      /* @__PURE__ */ r.jsxs(F, { className: "text-sm font-medium", children: [
        "Volumes to ",
        m.isDownloadMode ? "Download" : "Save"
      ] }),
      /* @__PURE__ */ r.jsx("div", { className: "mt-2 space-y-4 max-h-48 overflow-y-auto", children: m.volumes.map((g, f) => {
        var C;
        const p = (C = e.current) == null ? void 0 : C.volumes[f];
        return !g || !p ? null : /* @__PURE__ */ r.jsxs(
          "div",
          {
            className: "flex items-center gap-3 p-3 border rounded-md",
            children: [
              /* @__PURE__ */ r.jsx(
                Ve,
                {
                  id: `volume-${f}`,
                  checked: g.enabled,
                  onCheckedChange: (x) => l(f, x === !0)
                }
              ),
              /* @__PURE__ */ r.jsxs("div", { className: "flex-1 min-w-0", children: [
                /* @__PURE__ */ r.jsx(
                  F,
                  {
                    htmlFor: `volume-${f}`,
                    className: "text-sm font-medium",
                    children: p.name || `Volume ${f + 1}`
                  }
                ),
                /* @__PURE__ */ r.jsx(
                  ca,
                  {
                    type: "text",
                    placeholder: m.isDownloadMode ? "Enter filename..." : "Enter path...",
                    value: g.url || "",
                    onChange: (x) => a(f, x.target.value),
                    className: "mt-1 text-xs"
                  }
                ),
                !m.isDownloadMode && g.isExternal && !g.enabled && /* @__PURE__ */ r.jsx("p", { className: "text-xs text-muted-foreground mt-1", children: "External URL - check to save with custom path" })
              ] })
            ]
          },
          f
        );
      }) })
    ] }),
    /* @__PURE__ */ r.jsxs(ji, { children: [
      /* @__PURE__ */ r.jsx(q, { variant: "outline", onClick: n, children: "Cancel" }),
      /* @__PURE__ */ r.jsx(
        q,
        {
          onClick: t,
          disabled: !m.document.enabled && !m.volumes.some((g) => g.enabled),
          children: "OK"
        }
      )
    ] })
  ] }) });
}
function Fw({ nvRef: e }) {
  const t = T((d) => d.settingsDialogOpen), n = T(
    (d) => d.setSettingsDialogOpen
  ), a = T(
    (d) => d.skipRemoveConfirmation
  ), l = T(
    (d) => d.setSkipRemoveConfirmation
  ), i = T(
    (d) => d.skipImagingUploadConfirmation
  ), o = T(
    (d) => d.setSkipImagingUploadConfirmation
  ), s = T(
    (d) => d.skipSessionDeleteConfirmation
  ), c = T(
    (d) => d.setSkipSessionDeleteConfirmation
  ), {
    viewerOptions: u,
    handleCrosshairWidthChange: m,
    handleCrosshairGapChange: g,
    handleInterpolateVoxelsChange: f,
    handleCrosshairVisibleChange: p,
    handleCrosshairColorChange: C,
    handleOverlayOutlineWidthChange: x,
    handleColorbarChange: S,
    handleRadiologicalChange: h
  } = xu(e);
  return /* @__PURE__ */ r.jsx(Ni, { open: t, onOpenChange: n, children: /* @__PURE__ */ r.jsxs(
    bl,
    {
      onClose: () => n(!1),
      className: "max-w-2xl",
      children: [
        /* @__PURE__ */ r.jsxs(Ei, { children: [
          /* @__PURE__ */ r.jsx(xl, { children: "FreeBrowse Settings" }),
          /* @__PURE__ */ r.jsx(Sl, { children: "Configure the FreeBrowse viewer settings" })
        ] }),
        /* @__PURE__ */ r.jsxs("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6 py-4", children: [
          /* @__PURE__ */ r.jsxs("div", { className: "space-y-6", children: [
            /* @__PURE__ */ r.jsx("h3", { className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: "Appearance" }),
            /* @__PURE__ */ r.jsxs("div", { className: "space-y-4", children: [
              /* @__PURE__ */ r.jsxs("div", { className: "flex items-center justify-between", children: [
                /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Crosshair Width" }),
                /* @__PURE__ */ r.jsx(
                  q,
                  {
                    variant: "ghost",
                    size: "sm",
                    className: "h-6 w-6 p-0",
                    onClick: () => p(
                      !u.crosshairVisible
                    ),
                    children: u.crosshairVisible ? /* @__PURE__ */ r.jsx(wu, { className: "h-4 w-4" }) : /* @__PURE__ */ r.jsx(Cu, { className: "h-4 w-4 opacity-50" })
                  }
                )
              ] }),
              /* @__PURE__ */ r.jsx(
                _e,
                {
                  label: "",
                  value: u.crosshairWidth,
                  onValueChange: m,
                  min: 0,
                  max: 5,
                  step: 0.1,
                  decimalPlaces: 1,
                  disabled: !u.crosshairVisible
                }
              )
            ] }),
            /* @__PURE__ */ r.jsx("div", { className: "space-y-2", children: /* @__PURE__ */ r.jsx(
              _e,
              {
                label: "Crosshair Gap",
                value: u.crosshairGap,
                onValueChange: g,
                min: 0,
                max: 10,
                step: 0.5,
                decimalPlaces: 1,
                disabled: !u.crosshairVisible
              }
            ) }),
            /* @__PURE__ */ r.jsxs("div", { className: "space-y-2", children: [
              /* @__PURE__ */ r.jsx(F, { className: "text-sm font-medium", children: "Crosshair Color" }),
              /* @__PURE__ */ r.jsx(
                ca,
                {
                  type: "color",
                  value: `#${Math.round(u.crosshairColor[0] * 255).toString(16).padStart(2, "0")}${Math.round(
                    u.crosshairColor[1] * 255
                  ).toString(16).padStart(2, "0")}${Math.round(
                    u.crosshairColor[2] * 255
                  ).toString(16).padStart(2, "0")}`,
                  onChange: (d) => C(d.target.value),
                  className: "w-full h-10"
                }
              )
            ] }),
            /* @__PURE__ */ r.jsx("div", { className: "space-y-2", children: /* @__PURE__ */ r.jsx(
              _e,
              {
                label: "Overlay Outline Width",
                value: u.overlayOutlineWidth,
                onValueChange: x,
                min: 0,
                max: 2,
                step: 0.1,
                decimalPlaces: 1
              }
            ) })
          ] }),
          /* @__PURE__ */ r.jsxs("div", { className: "space-y-6", children: [
            /* @__PURE__ */ r.jsxs("div", { className: "space-y-3", children: [
              /* @__PURE__ */ r.jsx("h3", { className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: "View Options" }),
              /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ r.jsx(
                  Ve,
                  {
                    id: "show-colorbar",
                    checked: u.isColorbar,
                    onCheckedChange: (d) => S(d)
                  }
                ),
                /* @__PURE__ */ r.jsx(F, { htmlFor: "show-colorbar", className: "text-sm font-medium", children: "Show Colorbar" })
              ] }),
              /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ r.jsx(
                  Ve,
                  {
                    id: "radiological-view",
                    checked: u.isRadiologicalConvention,
                    onCheckedChange: (d) => h(d)
                  }
                ),
                /* @__PURE__ */ r.jsx(
                  F,
                  {
                    htmlFor: "radiological-view",
                    className: "text-sm font-medium",
                    children: "Radiological View"
                  }
                )
              ] }),
              /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ r.jsx(
                  Ve,
                  {
                    id: "interpolate-voxels",
                    checked: u.interpolateVoxels,
                    onCheckedChange: (d) => f(d)
                  }
                ),
                /* @__PURE__ */ r.jsx(
                  F,
                  {
                    htmlFor: "interpolate-voxels",
                    className: "text-sm font-medium",
                    children: "Interpolate Voxels"
                  }
                )
              ] })
            ] }),
            /* @__PURE__ */ r.jsxs("div", { className: "space-y-3", children: [
              /* @__PURE__ */ r.jsx("h3", { className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: "Confirmations" }),
              /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ r.jsx(
                  Ve,
                  {
                    id: "skip-remove-confirmation",
                    checked: a,
                    onCheckedChange: (d) => l(d)
                  }
                ),
                /* @__PURE__ */ r.jsx(
                  F,
                  {
                    htmlFor: "skip-remove-confirmation",
                    className: "text-sm font-medium",
                    children: "Don't ask me to confirm removals"
                  }
                )
              ] }),
              /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ r.jsx(
                  Ve,
                  {
                    id: "skip-imaging-upload-confirmation-settings",
                    checked: i,
                    onCheckedChange: (d) => o(d)
                  }
                ),
                /* @__PURE__ */ r.jsx(
                  F,
                  {
                    htmlFor: "skip-imaging-upload-confirmation-settings",
                    className: "text-sm font-medium",
                    children: "Don't ask me to confirm imaging data uploads"
                  }
                )
              ] }),
              /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2", children: [
                /* @__PURE__ */ r.jsx(
                  Ve,
                  {
                    id: "skip-session-delete-confirmation-settings",
                    checked: s,
                    onCheckedChange: (d) => c(d)
                  }
                ),
                /* @__PURE__ */ r.jsx(
                  F,
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
        /* @__PURE__ */ r.jsx(ji, { children: /* @__PURE__ */ r.jsx(q, { onClick: () => n(!1), children: "Close" }) })
      ]
    }
  ) });
}
function Kw({
  onConfirm: e,
  onCancel: t
}) {
  const n = T((o) => o.imagingUploadConfirmDialogOpen), a = T((o) => o.setImagingUploadConfirmDialogOpen), l = T((o) => o.skipImagingUploadConfirmation), i = T((o) => o.setSkipImagingUploadConfirmation);
  return /* @__PURE__ */ r.jsx(Ni, { open: n, onOpenChange: a, children: /* @__PURE__ */ r.jsxs(bl, { onClose: t, children: [
    /* @__PURE__ */ r.jsxs(Ei, { children: [
      /* @__PURE__ */ r.jsx(xl, { children: "Upload imaging data to backend?" }),
      /* @__PURE__ */ r.jsx(Sl, { children: "Warning: this operation will transfer imaging data to the backend server. Are you sure you want to proceed?" })
    ] }),
    /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2 mt-4", children: [
      /* @__PURE__ */ r.jsx(
        Ve,
        {
          id: "skip-imaging-upload-confirmation",
          checked: l,
          onCheckedChange: (o) => i(o === !0)
        }
      ),
      /* @__PURE__ */ r.jsx(
        F,
        {
          htmlFor: "skip-imaging-upload-confirmation",
          className: "text-sm",
          children: "Don't ask me again to confirm imaging data uploads"
        }
      )
    ] }),
    /* @__PURE__ */ r.jsxs(ji, { children: [
      /* @__PURE__ */ r.jsx(q, { variant: "outline", onClick: t, children: "Cancel" }),
      /* @__PURE__ */ r.jsx(q, { onClick: e, children: "Upload" })
    ] })
  ] }) });
}
function Jw({
  onConfirm: e,
  onCancel: t
}) {
  const n = T((o) => o.sessionDeleteConfirmDialogOpen), a = T((o) => o.setSessionDeleteConfirmDialogOpen), l = T((o) => o.skipSessionDeleteConfirmation), i = T((o) => o.setSkipSessionDeleteConfirmation);
  return /* @__PURE__ */ r.jsx(Ni, { open: n, onOpenChange: a, children: /* @__PURE__ */ r.jsxs(bl, { onClose: t, children: [
    /* @__PURE__ */ r.jsxs(Ei, { children: [
      /* @__PURE__ */ r.jsx(xl, { children: "Delete this session?" }),
      /* @__PURE__ */ r.jsx(Sl, { children: "Are you sure you want to delete this session? The session folder and its contents will be removed from the backend." })
    ] }),
    /* @__PURE__ */ r.jsxs("div", { className: "flex items-center space-x-2 mt-4", children: [
      /* @__PURE__ */ r.jsx(
        Ve,
        {
          id: "skip-session-delete-confirmation",
          checked: l,
          onCheckedChange: (o) => i(o === !0)
        }
      ),
      /* @__PURE__ */ r.jsx(
        F,
        {
          htmlFor: "skip-session-delete-confirmation",
          className: "text-sm",
          children: "Don't ask me to confirm session deletions"
        }
      )
    ] }),
    /* @__PURE__ */ r.jsxs(ji, { children: [
      /* @__PURE__ */ r.jsx(q, { variant: "outline", onClick: t, children: "Cancel" }),
      /* @__PURE__ */ r.jsx(q, { variant: "destructive", onClick: e, children: "Delete" })
    ] })
  ] }) });
}
function Iw({
  nv: e,
  exposeGlobal: t,
  hostInstance: n = !1,
  dragDrop: a,
  sidebar: l,
  footer: i
}) {
  const o = t ?? Za().exposeGlobal;
  v.useEffect(() => {
    const un = {};
    a !== void 0 && (un.dragDropEnabled = a, a || (un.showUploader = !1)), l !== void 0 && (un.sidebarOpen = l), i !== void 0 && (un.footerOpen = i), Object.keys(un).length && T.setState(un);
  }, [a, l, i]);
  const s = v.useRef(e);
  s.current = e, v.useEffect(() => {
    const un = p1(e, Y1(e));
    return o && (window.freebrowse = { nv: e }), () => {
      var Lu;
      un(), ((Lu = window.freebrowse) == null ? void 0 : Lu.nv) === e && delete window.freebrowse;
    };
  }, [e, o]);
  const {
    viewerOptions: c,
    applyViewerOptions: u,
    syncViewerOptionsFromNiiVue: m,
    debouncedGLUpdate: g
  } = xu(s, n ? "sync" : "apply"), {
    updateSurfaceDetails: f,
    toggleSurfaceVisibility: p,
    removeSurface: C,
    handleRemoveSurfaceClick: x,
    handleSurfaceOpacityChange: S,
    handleSurfaceColorChange: h,
    handleMeshShaderChange: d
  } = Q1(s), {
    layerFileInputRef: y,
    getLayers: b,
    removeLayer: N,
    handleLayerOpacityChange: O,
    handleLayerCalMinChange: M,
    handleLayerCalMaxChange: A,
    handleLayerColormapChange: w,
    handleLayerUseNegativeCmapChange: E,
    handleAddLayerFiles: R,
    handleLayerFileChange: k
  } = Z1(s), {
    getVolumes: V,
    toggleImageVisibility: J,
    handleOpacityChange: z,
    handleFrameChange: j,
    handleContrastMinChange: U,
    handleContrastMaxChange: D,
    handleColormapChange: Q,
    handleMoveVolumeUp: I,
    handleMoveVolumeDown: Be,
    handleRemoveVolumeClick: we,
    handleEditVolume: ie,
    canEditVolume: ne,
    handleConfirmRemove: Qe,
    handleCancelRemove: ln
  } = X1(s, g, C), {
    handleCreateDrawingLayer: ye,
    handleDrawingColormapChange: ga,
    handleDrawModeChange: on,
    handlePenFillChange: sn,
    handlePenErasesChange: rn,
    handlePenValueChange: cn,
    handleDrawingOpacityChange: Ns,
    handleMagicWand2dOnlyChange: H,
    handleMagicWandMaxDistanceChange: Rt,
    handleMagicWandThresholdChange: Cl,
    handleDrawUndo: Mi,
    handleSaveDrawing: Es
  } = F1(s);
  $1(s);
  const {
    handleSaveScene: Qp,
    handleConfirmSave: Zp,
    handleCancelSave: Fp,
    handleVolumeUrlChange: Kp,
    handleVolumeCheckboxChange: Jp,
    handleDocumentLocationChange: Ip,
    handleDocumentCheckboxChange: Wp,
    handleDocumentFormatChange: $p
  } = ax(s), {
    serverlessMode: Pp,
    fileInputRef: ey,
    surfaceFileInputRef: ty,
    handleFileUpload: ny,
    handleImagingFileSelect: ay,
    handleNvdFileSelect: ly,
    handleFileChange: iy,
    handleAddMoreFiles: oy,
    handleAddSurfaceFiles: sy,
    handleSurfaceFileChange: ry
  } = lx(
    s,
    u,
    m,
    f
  );
  ix();
  const {
    refreshSessions: cy,
    handleNewSession: uy,
    handleLoadSession: fy,
    handleRunSegmentation: dy,
    handleExitAndSaveSession: my,
    handleExitAndDeleteSession: hy
  } = mx(s);
  return /* @__PURE__ */ r.jsx(
    CC,
    {
      nvInstance: e,
      viewMode: c.viewMode,
      onFileUpload: ny,
      sidebar: /* @__PURE__ */ r.jsx(
        _w,
        {
          nvRef: s,
          serverlessMode: Pp,
          onNvdFileSelect: ly,
          onImagingFileSelect: ay,
          onAddMoreFiles: oy,
          onAddSurfaceFiles: sy,
          getVolumes: V,
          onToggleImageVisibility: J,
          onEditVolume: ie,
          canEditVolume: ne,
          onRemoveVolumeClick: we,
          onOpacityChange: z,
          onFrameChange: j,
          onContrastMinChange: U,
          onContrastMaxChange: D,
          onColormapChange: Q,
          onMoveVolumeUp: I,
          onMoveVolumeDown: Be,
          onToggleSurfaceVisibility: p,
          onRemoveSurfaceClick: x,
          onSurfaceOpacityChange: S,
          onSurfaceColorChange: h,
          onMeshShaderChange: d,
          getLayers: b,
          onAddLayerFiles: R,
          onRemoveLayer: N,
          onLayerOpacityChange: O,
          onLayerCalMinChange: M,
          onLayerCalMaxChange: A,
          onLayerColormapChange: w,
          onLayerUseNegativeCmapChange: E,
          onCreateDrawingLayer: ye,
          onDrawModeChange: on,
          onDrawingColormapChange: ga,
          onPenFillChange: sn,
          onPenErasesChange: rn,
          onPenValueChange: cn,
          onDrawingOpacityChange: Ns,
          onMagicWand2dOnlyChange: H,
          onMagicWandMaxDistanceChange: Rt,
          onMagicWandThresholdChange: Cl,
          onDrawUndo: Mi,
          onSaveDrawing: Es,
          onSaveScene: Qp,
          onAiNewSession: uy,
          onAiLoadSession: fy,
          onAiRunSegmentation: dy,
          onAiExitAndSaveSession: my,
          onAiExitAndDeleteSession: hy,
          onAiRefreshSessions: cy
        }
      ),
      dialogs: /* @__PURE__ */ r.jsxs(r.Fragment, { children: [
        /* @__PURE__ */ r.jsx(
          Ow,
          {
            onConfirm: Qe,
            onCancel: ln
          }
        ),
        /* @__PURE__ */ r.jsx(
          Zw,
          {
            nvRef: s,
            onConfirm: Zp,
            onCancel: Fp,
            onVolumeUrlChange: Kp,
            onVolumeCheckboxChange: Jp,
            onDocumentLocationChange: Ip,
            onDocumentCheckboxChange: Wp,
            onDocumentFormatChange: $p
          }
        ),
        /* @__PURE__ */ r.jsx(Fw, { nvRef: s }),
        /* @__PURE__ */ r.jsx(
          Kw,
          {
            onConfirm: () => pd(!0),
            onCancel: () => pd(!1)
          }
        ),
        /* @__PURE__ */ r.jsx(
          Jw,
          {
            onConfirm: () => yd(!0),
            onCancel: () => yd(!1)
          }
        )
      ] }),
      hiddenInputs: /* @__PURE__ */ r.jsxs(r.Fragment, { children: [
        /* @__PURE__ */ r.jsx(
          "input",
          {
            type: "file",
            ref: ey,
            onChange: iy,
            multiple: !0,
            className: "hidden"
          }
        ),
        /* @__PURE__ */ r.jsx(
          "input",
          {
            type: "file",
            ref: ty,
            onChange: ry,
            multiple: !0,
            className: "hidden"
          }
        ),
        /* @__PURE__ */ r.jsx(
          "input",
          {
            type: "file",
            ref: y,
            onChange: k,
            multiple: !0,
            className: "hidden"
          }
        )
      ] })
    }
  );
}
let Ji = null;
function $w(e, t = {}) {
  var o;
  if (Ji)
    throw new Error(
      "FreeBrowse: already mounted; call destroy() on the existing handle before mounting again"
    );
  const n = t.nv !== void 0, a = t.nv ?? nx();
  j1({
    backend: t.backend ?? null,
    persist: t.persist ?? "freebrowse-user-settings",
    readUrlParams: t.readUrlParams ?? !1,
    exposeGlobal: t.exposeGlobal ?? !1,
    downloadDisabled: t.downloadDisabled ?? !1
  });
  const l = { sidebar: t.sidebar, footer: t.footer };
  (o = T.persist.rehydrate()) == null || o.then(() => {
    const s = {};
    l.sidebar !== void 0 && (s.sidebarOpen = l.sidebar), l.footer !== void 0 && (s.footerOpen = l.footer), Object.keys(s).length && T.setState(s);
  });
  const i = g1.createRoot(e);
  return Ji = i, i.render(
    /* @__PURE__ */ r.jsx(
      Iw,
      {
        nv: a,
        hostInstance: n,
        dragDrop: t.dragDrop,
        sidebar: t.sidebar,
        footer: t.footer
      }
    )
  ), {
    nv: a,
    destroy() {
      Ji === i && (i.unmount(), Ji = null);
    }
  };
}
export {
  tx as DEFAULT_NIIVUE_OPTIONS,
  j1 as configureFreeBrowse,
  nx as createFreeBrowseInstance,
  Za as getFreeBrowseConfig,
  $w as mountFreeBrowse
};
