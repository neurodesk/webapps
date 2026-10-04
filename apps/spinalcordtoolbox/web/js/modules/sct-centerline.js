/*
 * Spinal cord centerline, as SCT 7.3 computes it.
 *
 * `getCenterline` is `spinalcordtoolbox.centerline.core.get_centerline` with
 * `algo_fitting='bspline'`: per-slice centre of mass of the non-zero voxels,
 * then SciPy's smoothing spline (`splrep`/`splev`). `splrep` is a port of
 * FITPACK's `curfit`/`fpcurf` (Dierckx) so the fitted positions and
 * derivatives match SciPy's instead of approximating them; the cord angles
 * that correct every morphometric and lesion measure come from those
 * derivatives.
 *
 * Volumes are in SCT's RPI convention: x runs right to left, y posterior to
 * anterior, z inferior to superior, index = x + y * nx + z * nx * ny. A RAS
 * volume becomes RPI by flipping x (`rasToRpi`).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.SCTCenterline = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ==================== Python-compatible helpers ====================

  /** Python 3 / NumPy `round`: halves go to the even integer. */
  function roundHalfEven(value) {
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff < 0.5) return floor;
    if (diff > 0.5) return floor + 1;
    return floor % 2 === 0 ? floor : floor + 1;
  }

  /** Python `repr(float)`: shortest round-trip digits, Python's exponent rules. */
  function pythonFloatRepr(value) {
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
    const exponential = value.toExponential();
    const [mantissa, exponentText] = exponential.split('e');
    const exponent = Number(exponentText);
    const negative = mantissa.startsWith('-');
    const digits = mantissa.replace('-', '').replace('.', '');
    let body;
    if (exponent < -4 || exponent >= 16) {
      const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
      const sign = exponent < 0 ? '-' : '+';
      body = `${digits[0]}${fraction}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
    } else if (exponent < 0) {
      body = `0.${'0'.repeat(-exponent - 1)}${digits}`;
    } else if (digits.length <= exponent + 1) {
      body = `${digits}${'0'.repeat(exponent + 1 - digits.length)}.0`;
    } else {
      body = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
    }
    return negative ? `-${body}` : body;
  }

  /** NumPy's pairwise summation, so sums and means round as NumPy's do. */
  function pairwiseSum(values, start = 0, count = values.length - start) {
    if (count < 8) {
      let sum = 0;
      for (let i = 0; i < count; i++) sum += values[start + i];
      return sum;
    }
    if (count <= 128) {
      const r = [0, 0, 0, 0, 0, 0, 0, 0];
      for (let j = 0; j < 8; j++) r[j] = values[start + j];
      let i = 8;
      for (; i < count - (count % 8); i += 8) {
        for (let j = 0; j < 8; j++) r[j] += values[start + i + j];
      }
      let sum = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
      for (; i < count; i++) sum += values[start + i];
      return sum;
    }
    let half = Math.floor(count / 2);
    half -= half % 8;
    return pairwiseSum(values, start, half) + pairwiseSum(values, start + half, count - half);
  }

  /**
   * SCT's `get_dimension`: NIfTI stores voxel sizes as float32, and SCT
   * rounds each one to the decimals a float32 can carry (0.800000011920929
   * becomes 0.8) before using it. Idempotent.
   */
  function sctVoxelSize(value) {
    const single = Math.fround(value);
    if (!Number.isFinite(single) || single === 0) return value;
    const ulp = Math.pow(2, Math.floor(Math.log2(Math.abs(single))) - 23);
    const decimals = -Math.floor(Math.log10(ulp)) - 1;
    if (decimals <= 0) return single;
    return Number(single.toFixed(Math.min(decimals, 100)));
  }

  function sctSpacing(spacing) {
    return [sctVoxelSize(spacing[0]), sctVoxelSize(spacing[1]), sctVoxelSize(spacing[2])];
  }

  function rasToRpi(data, dims) {
    const [nx, ny, nz] = dims;
    const out = new data.constructor(data.length);
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const row = (y + z * ny) * nx;
        for (let x = 0; x < nx; x++) {
          out[row + (nx - 1 - x)] = data[row + x];
        }
      }
    }
    return out;
  }

  /**
   * SCT rounds and reports some coordinates in the orientation the image is
   * stored in. Given the shared RAS transform's `flip` (true where the stored
   * axis runs against RAS), this says, per RPI axis, whether the stored axis
   * runs against RPI.
   */
  function nativeFlipsFromRas(rasFlip) {
    return [!rasFlip[0], Boolean(rasFlip[1]), Boolean(rasFlip[2])];
  }

  // ==================== FITPACK (1-based, as in the Fortran) ====================

  function fpbspl(t, k, x, l, h) {
    const hh = new Float64Array(20);
    h[1] = 1;
    for (let j = 1; j <= k; j++) {
      for (let i = 1; i <= j; i++) hh[i] = h[i];
      h[1] = 0;
      for (let i = 1; i <= j; i++) {
        const li = l + i;
        const lj = li - j;
        if (t[li] === t[lj]) {
          h[i + 1] = 0;
          continue;
        }
        const f = hh[i] / (t[li] - t[lj]);
        h[i] = h[i] + f * (t[li] - x);
        h[i + 1] = f * (x - t[lj]);
      }
    }
  }

  // Returns [dd, cos, sin]; the caller stores dd back into the pivot.
  function fpgivs(piv, ww) {
    const store = Math.abs(piv);
    let dd;
    if (store >= ww) dd = store * Math.sqrt(1 + (ww / piv) * (ww / piv));
    else dd = ww * Math.sqrt(1 + (piv / ww) * (piv / ww));
    return [dd, ww / dd, piv / dd];
  }

  function fpback(a, z, n, k, c) {
    const k1 = k - 1;
    c[n] = z[n] / a[n][1];
    let i = n - 1;
    if (i === 0) return;
    for (let j = 2; j <= n; j++) {
      let store = z[i];
      let i1 = k1;
      if (j <= k1) i1 = j - 1;
      let m = i;
      for (let l = 1; l <= i1; l++) {
        m += 1;
        store -= c[m] * a[i][l + 1];
      }
      c[i] = store / a[i][1];
      i -= 1;
    }
  }

  function fpdisc(t, n, k2, b) {
    const h = new Float64Array(13);
    const k1 = k2 - 1;
    const k = k1 - 1;
    const nk1 = n - k1;
    const nrint = nk1 - k;
    const fac = nrint / (t[nk1 + 1] - t[k1]);
    for (let l = k2; l <= nk1; l++) {
      const lmk = l - k1;
      for (let j = 1; j <= k1; j++) {
        const ik = j + k1;
        const lj = l + j;
        const lk = lj - k2;
        h[j] = t[l] - t[lk];
        h[ik] = t[l] - t[lj];
      }
      let lp = lmk;
      for (let j = 1; j <= k2; j++) {
        let jk = j;
        let prod = h[j];
        for (let i = 1; i <= k; i++) {
          jk += 1;
          prod = prod * h[jk] * fac;
        }
        const lk = lp + k1;
        b[lmk][j] = (t[lk] - t[lp]) / prod;
        lp += 1;
      }
    }
  }

  // Adds one knot in the interval with the largest residual. Returns the new
  // [n, nrint].
  function fpknot(x, t, n, fpint, nrdata, nrint, istart) {
    const k = Math.trunc((n - nrint - 1) / 2);
    let fpmax = 0;
    let jbegin = istart;
    let number = 0;
    let maxpt = 0;
    let maxbeg = 0;
    let iserr = true;
    for (let j = 1; j <= nrint; j++) {
      const jpoint = nrdata[j];
      if (!(fpmax >= fpint[j] || jpoint === 0)) {
        iserr = false;
        fpmax = fpint[j];
        number = j;
        maxpt = jpoint;
        maxbeg = jbegin;
      }
      jbegin = jbegin + jpoint + 1;
    }
    if (!iserr) {
      const ihalf = Math.trunc(maxpt / 2) + 1;
      const nrx = maxbeg + ihalf;
      const next = number + 1;
      if (next <= nrint) {
        for (let j = next; j <= nrint; j++) {
          const jj = next + nrint - j;
          fpint[jj + 1] = fpint[jj];
          nrdata[jj + 1] = nrdata[jj];
          const jk = jj + k;
          t[jk + 1] = t[jk];
        }
      }
      nrdata[number] = ihalf - 1;
      nrdata[next] = maxpt - ihalf;
      fpint[number] = fpmax * nrdata[number] / maxpt;
      fpint[next] = fpmax * nrdata[next] / maxpt;
      t[next + k] = x[nrx];
    }
    return [n + 1, nrint + 1];
  }

  function fprati(state) {
    const { p1, f1, p2, f2, p3, f3 } = state;
    let p;
    if (p3 > 0) {
      const h1 = f1 * (f2 - f3);
      const h2 = f2 * (f3 - f1);
      const h3 = f3 * (f1 - f2);
      p = -(p1 * p2 * h3 + p2 * p3 * h1 + p3 * p1 * h2) / (p1 * h1 + p2 * h2 + p3 * h3);
    } else {
      p = (p1 * (f1 - f3) * f2 - p2 * (f2 - f3) * f1) / ((f1 - f2) * f3);
    }
    if (f2 < 0) {
      state.p3 = p2;
      state.f3 = f2;
    } else {
      state.p1 = p2;
      state.f1 = f2;
    }
    return p;
  }

  function matrix(rows, cols) {
    return Array.from({ length: rows + 1 }, () => new Float64Array(cols + 1));
  }

  /**
   * `scipy.interpolate.splrep(x, y, s=s, k=k)` with unit weights: FITPACK
   * `curfit` (iopt = 0, tol = 1e-3, maxit = 20). Returns the knots and
   * coefficients as 0-based arrays plus FITPACK's `fp` and `ier`.
   */
  function splrep(xIn, yIn, s, k = 3) {
    const m = xIn.length;
    if (!(k >= 1 && k <= 5)) throw new Error('splrep: degree must be between 1 and 5');
    if (m <= k) throw new Error(`splrep: ${m} point(s) cannot define a degree-${k} spline`);
    if (!(s >= 0)) throw new Error('splrep: smoothing must be non-negative');
    for (let i = 1; i < m; i++) {
      if (xIn[i - 1] > xIn[i]) throw new Error('splrep: x must be increasing');
    }

    const k1 = k + 1;
    const k2 = k1 + 1;
    const nest = Math.max(m + k + 1, 2 * k + 3);
    const tol = 0.001;
    const maxit = 20;
    const x = new Float64Array(m + 1);
    const y = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) {
      x[i + 1] = xIn[i];
      y[i + 1] = yIn[i];
    }
    const xb = x[1];
    const xe = x[m];
    const t = new Float64Array(nest + 2);
    const c = new Float64Array(nest + 2);
    const fpint = new Float64Array(nest + 2);
    const z = new Float64Array(nest + 2);
    const nrdata = new Int32Array(nest + 2);
    const a = matrix(nest, k1);
    const b = matrix(nest, k2);
    const g = matrix(nest, k2);
    const q = matrix(m, k1);
    const h = new Float64Array(21);

    const nmin = 2 * k1;
    const acc = tol * s;
    const nmax = m + k1;
    let n;
    let ier = 0;
    let fp = 0;
    let fp0 = 0;
    let fpold = 0;
    let fpms = 0;
    let nplus = 0;
    let nk1 = 0;
    let interpolationKnots = false;

    if (s > 0) {
      n = nmin;
      nrdata[1] = m - 2;
    } else {
      n = nmax;
      interpolationKnots = true;
    }

    const finish = () => ({
      t: Array.from(t.subarray(1, n + 1)),
      c: Array.from(c.subarray(1, n + 1)),
      k,
      fp,
      ier
    });

    // Part 1: number of knots and their position.
    let accepted = false;
    outer:
    for (;;) {
      if (interpolationKnots) {
        // Label 10: knots as for interpolation.
        interpolationKnots = false;
        const mk1 = m - k1;
        if (mk1 !== 0) {
          const k3 = Math.trunc(k / 2);
          let i = k2;
          let j = k3 + 2;
          if (k3 * 2 === k) {
            for (let l = 1; l <= mk1; l++) {
              t[i] = (x[j] + x[j - 1]) * 0.5;
              i += 1;
              j += 1;
            }
          } else {
            for (let l = 1; l <= mk1; l++) {
              t[i] = x[j];
              i += 1;
              j += 1;
            }
          }
        }
      }

      // Label 60: main loop over knot sets.
      let restart = false;
      for (let iter = 1; iter <= m; iter++) {
        if (n === nmin) ier = -2;
        let nrint = n - nmin + 1;
        nk1 = n - k1;
        let i = n;
        for (let j = 1; j <= k1; j++) {
          t[j] = xb;
          t[i] = xe;
          i -= 1;
        }
        fp = 0;
        for (let ii = 1; ii <= nk1; ii++) {
          z[ii] = 0;
          for (let j = 1; j <= k1; j++) a[ii][j] = 0;
        }
        let l = k1;
        for (let it = 1; it <= m; it++) {
          const xi = x[it];
          let yi = y[it];
          while (!(xi < t[l + 1] || l === nk1)) l += 1;
          fpbspl(t, k, xi, l, h);
          for (let ii = 1; ii <= k1; ii++) q[it][ii] = h[ii];
          let j = l - k1;
          for (let ii = 1; ii <= k1; ii++) {
            j += 1;
            const piv = h[ii];
            if (piv === 0) continue;
            const [dd, cos, sin] = fpgivs(piv, a[j][1]);
            a[j][1] = dd;
            // fprota(cos, sin, yi, z(j))
            const zOld = z[j];
            z[j] = cos * zOld + sin * yi;
            yi = cos * yi - sin * zOld;
            if (ii === k1) break;
            let i2 = 1;
            for (let i1 = ii + 1; i1 <= k1; i1++) {
              i2 += 1;
              const hOld = h[i1];
              const aOld = a[j][i2];
              a[j][i2] = cos * aOld + sin * hOld;
              h[i1] = cos * hOld - sin * aOld;
            }
          }
          fp += yi * yi;
        }
        if (ier === -2) fp0 = fp;
        fpint[n] = fp0;
        fpint[n - 1] = fpold;
        nrdata[n] = nplus;
        fpback(a, z, nk1, k1, c);
        fpms = fp - s;
        if (Math.abs(fpms) < acc) return finish();
        if (fpms < 0) {
          accepted = true;
          break outer;
        }
        if (n === nmax) {
          ier = -1;
          return finish();
        }
        if (n === nest) {
          ier = 1;
          return finish();
        }
        if (ier === 0) {
          let npl1 = nplus * 2;
          if (fpold - fp > acc) npl1 = Math.trunc(nplus * fpms / (fpold - fp));
          nplus = Math.min(nplus * 2, Math.max(npl1, Math.trunc(nplus / 2), 1));
        } else {
          nplus = 1;
          ier = 0;
        }
        fpold = fp;
        let fpart = 0;
        i = 1;
        l = k2;
        let isNew = 0;
        for (let it = 1; it <= m; it++) {
          if (!(x[it] < t[l] || l > nk1)) {
            isNew = 1;
            l += 1;
          }
          let term = 0;
          let l0 = l - k2;
          for (let j = 1; j <= k1; j++) {
            l0 += 1;
            term += c[l0] * q[it][j];
          }
          term = (term - y[it]) * (term - y[it]);
          fpart += term;
          if (isNew === 0) continue;
          const store = term * 0.5;
          fpint[i] = fpart - store;
          i += 1;
          fpart = store;
          isNew = 0;
        }
        fpint[nrint] = fpart;
        for (let lAdd = 1; lAdd <= nplus; lAdd++) {
          [n, nrint] = fpknot(x, t, n, fpint, nrdata, nrint, 1);
          if (n === nmax) {
            interpolationKnots = true;
            restart = true;
            break;
          }
          if (n === nest) break;
        }
        if (restart) break;
      }
      if (!restart) break;
    }

    // Label 250.
    if (!accepted && ier !== -2) {
      // The knot loop ran out of trials (FITPACK falls through to part 2).
    }
    if (ier === -2) return finish();

    // Part 2: the smoothing spline sp(x) with f(p) = s.
    fpdisc(t, n, k2, b);
    const state = { p1: 0, f1: fp0 - s, p2: 0, f2: 0, p3: -1, f3: fpms };
    let p = 0;
    for (let i = 1; i <= nk1; i++) p += a[i][1];
    p = nk1 / p;
    let ich1 = 0;
    let ich3 = 0;
    const n8 = n - nmin;
    for (let iter = 1; iter <= maxit; iter++) {
      const pinv = 1 / p;
      for (let i = 1; i <= nk1; i++) {
        c[i] = z[i];
        g[i][k2] = 0;
        for (let j = 1; j <= k1; j++) g[i][j] = a[i][j];
      }
      for (let it = 1; it <= n8; it++) {
        for (let i = 1; i <= k2; i++) h[i] = b[it][i] * pinv;
        let yi = 0;
        for (let j = it; j <= nk1; j++) {
          const piv = h[1];
          const [dd, cos, sin] = fpgivs(piv, g[j][1]);
          g[j][1] = dd;
          const cOld = c[j];
          c[j] = cos * cOld + sin * yi;
          yi = cos * yi - sin * cOld;
          if (j === nk1) break;
          let i2 = k1;
          if (j > n8) i2 = nk1 - j;
          for (let i = 1; i <= i2; i++) {
            const i1 = i + 1;
            const hOld = h[i1];
            const gOld = g[j][i1];
            g[j][i1] = cos * gOld + sin * hOld;
            h[i] = cos * hOld - sin * gOld;
          }
          h[i2 + 1] = 0;
        }
      }
      fpback(g, c, nk1, k2, c);
      fp = 0;
      let l = k2;
      for (let it = 1; it <= m; it++) {
        if (!(x[it] < t[l] || l > nk1)) l += 1;
        let l0 = l - k2;
        let term = 0;
        for (let j = 1; j <= k1; j++) {
          l0 += 1;
          term += c[l0] * q[it][j];
        }
        fp += (term - y[it]) * (term - y[it]);
      }
      fpms = fp - s;
      if (Math.abs(fpms) < acc) return finish();
      if (iter === maxit) {
        ier = 3;
        return finish();
      }
      state.p2 = p;
      state.f2 = fpms;
      if (ich3 === 0) {
        if (state.f2 - state.f3 <= acc) {
          // Initial p too large.
          state.p3 = state.p2;
          state.f3 = state.f2;
          p *= 0.04;
          if (p <= state.p1) p = state.p1 * 0.9 + state.p2 * 0.1;
          continue;
        }
        if (state.f2 < 0) ich3 = 1;
      }
      if (ich1 === 0) {
        if (state.f1 - state.f2 <= acc) {
          // Initial p too small.
          state.p1 = state.p2;
          state.f1 = state.f2;
          p /= 0.04;
          if (state.p3 < 0) continue;
          if (p >= state.p3) p = state.p2 * 0.1 + state.p3 * 0.9;
          continue;
        }
        if (state.f2 > 0) ich1 = 1;
      }
      if (state.f2 >= state.f1 || state.f2 <= state.f3) {
        ier = 2;
        return finish();
      }
      p = fprati(state);
    }
    ier = 3;
    return finish();
  }

  /**
   * `scipy.interpolate.splev(x, tck, der)` with `ext=0` (extrapolate) for
   * der = 0 or 1: FITPACK `splev` / `splder`.
   */
  function splev(xs, tck, der = 0) {
    const k = tck.k;
    const n = tck.t.length;
    const t = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) t[i + 1] = tck.t[i];
    const k1 = k + 1;
    const nk1 = n - k1;
    const wrk = new Float64Array(n + 2);
    for (let i = 1; i <= nk1; i++) wrk[i] = tck.c[i - 1];
    if (der < 0 || der > k) throw new Error('splev: derivative order out of range');

    let kk = k;
    let lBase = 1;
    let nk2 = nk1;
    for (let j = 1; j <= der; j++) {
      const ak = kk;
      nk2 -= 1;
      let l1 = lBase;
      for (let i = 1; i <= nk2; i++) {
        l1 += 1;
        const l2 = l1 + kk;
        const fac = t[l2] - t[l1];
        if (fac <= 0) continue;
        wrk[i] = ak * (wrk[i + 1] - wrk[i]) / fac;
      }
      lBase += 1;
      kk -= 1;
    }

    const out = new Float64Array(xs.length);
    const h = new Float64Array(21);
    const k3 = k1 + 1;
    if (kk === 0) {
      // Piecewise-constant derivative (a degree-1 spline differentiated once).
      let l = lBase;
      let j = 1;
      for (let i = 0; i < xs.length; i++) {
        const arg = xs[i];
        while (!(arg >= t[l] || l + 1 === k3)) {
          l -= 1;
          j -= 1;
        }
        while (!(arg < t[l + 1] || l === nk1)) {
          l += 1;
          j += 1;
        }
        out[i] = wrk[j];
      }
      return out;
    }

    let l = k1;
    let l1 = l + 1;
    const k2 = k1 - der;
    for (let i = 0; i < xs.length; i++) {
      const arg = xs[i];
      while (!(arg >= t[l] || l1 === k3)) {
        l1 = l;
        l -= 1;
      }
      while (!(arg < t[l1] || l === nk1)) {
        l = l1;
        l1 = l + 1;
      }
      fpbspl(t, kk, arg, l, h);
      let sp = 0;
      let ll = l - k1;
      for (let j = 1; j <= k2; j++) {
        ll += 1;
        sp += wrk[ll] * h[j];
      }
      out[i] = sp;
    }
    return out;
  }

  // ==================== Centerline ====================

  /**
   * `find_and_sort_coord`: mean x and y of the non-zero voxels of each slice
   * that has any.
   */
  function sliceCentersOfMass(data, dims) {
    const [nx, ny, nz] = dims;
    const xMean = [];
    const yMean = [];
    const zMean = [];
    for (let z = 0; z < nz; z++) {
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      const base = z * nx * ny;
      for (let y = 0; y < ny; y++) {
        const row = base + y * nx;
        for (let x = 0; x < nx; x++) {
          if (data[row + x]) {
            count += 1;
            sumX += x;
            sumY += y;
          }
        }
      }
      if (count > 0) {
        xMean.push(sumX / count);
        yMean.push(sumY / count);
        zMean.push(z);
      }
    }
    return { xMean, yMean, zMean };
  }

  /** `curve_fitting.bspline`. */
  function bsplineFit(x, y, xref, smooth, pz) {
    let degree = 3;
    if (x.length <= degree) degree -= 2;
    const density = (x.length / xref.length) * (x.length / xref.length);
    const s = density * smooth * pz / 3;
    const tck = splrep(x, y, s, degree);
    return { fit: splev(xref, tck, 0), deriv: splev(xref, tck, 1) };
  }

  /**
   * `get_centerline(im_seg, ParamCenterline(algo_fitting='bspline', smooth,
   * minmax))` on an RPI volume. `zRef` lists the slices the centerline is
   * evaluated on; `x`, `y` are voxel positions and `dx`, `dy` their
   * derivatives with respect to the slice index.
   */
  function getCenterline(data, dims, spacing, options = {}) {
    const smooth = options.smooth ?? 20;
    const minmax = options.minmax ?? true;
    const { xMean, yMean, zMean } = sliceCentersOfMass(data, dims);
    if (zMean.length === 0) throw new Error('The mask is empty: no centerline can be fitted.');
    if (zMean.length < 2) {
      throw new Error('The mask covers one slice: a centerline needs at least two slices.');
    }
    const zStart = minmax ? zMean[0] : 0;
    const zEnd = minmax ? zMean[zMean.length - 1] : dims[2] - 1;
    const zRef = [];
    for (let z = zStart; z <= zEnd; z++) zRef.push(z);
    const fx = bsplineFit(zMean, xMean, zRef, smooth, spacing[2]);
    const fy = bsplineFit(zMean, yMean, zRef, smooth, spacing[2]);
    return { zRef, x: fx.fit, y: fy.fit, dx: fx.deriv, dy: fy.deriv, xMean, yMean, zMean };
  }

  return {
    roundHalfEven,
    pythonFloatRepr,
    pairwiseSum,
    sctVoxelSize,
    sctSpacing,
    rasToRpi,
    nativeFlipsFromRas,
    splrep,
    splev,
    sliceCentersOfMass,
    getCenterline
  };
});
