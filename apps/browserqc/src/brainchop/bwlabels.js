export class BWLabeler {
  // port of https://github.com/rordenlab/niimath/blob/master/src/bwlabel.c
  // return voxel address given row A, column B, and slice C
  idx(A, B, C, DIM) {
    return C * DIM[0] * DIM[1] + B * DIM[0] + A
  } // idx()

  // determine if voxels below candidate voxel have already been assigned a label
  check_previous_slice(bw, il, r, c, sl, dim, conn, tt, nabo, tn) {
    let nr_set = 0
    if (!sl) {
      return 0
    }
    const val = bw[this.idx(r, c, sl, dim)]
    if (conn >= 6) {
      const idx = this.idx(r, c, sl - 1, dim)
      if (val === bw[idx]) {
        nabo[nr_set++] = il[idx]
      }
    }
    if (conn >= 18) {
      if (r) {
        const idx = this.idx(r - 1, c, sl - 1, dim)
        if (val === bw[idx]) {
          nabo[nr_set++] = il[idx]
        }
      }
      if (c) {
        const idx = this.idx(r, c - 1, sl - 1, dim)
        if (val === bw[idx]) {
          nabo[nr_set++] = il[idx]
        }
      }
      if (r < dim[0] - 1) {
        const idx = this.idx(r + 1, c, sl - 1, dim)
        if (val === bw[idx]) {
          nabo[nr_set++] = il[idx]
        }
      }
      if (c < dim[1] - 1) {
        const idx = this.idx(r, c + 1, sl - 1, dim)
        if (val === bw[idx]) {
          nabo[nr_set++] = il[idx]
        }
      }
    }
    if (conn === 26) {
      if (r && c) {
        const idx = this.idx(r - 1, c - 1, sl - 1, dim)
        if (val === bw[idx]) {
          nabo[nr_set++] = il[idx]
        }
      }
      if (r < dim[0] - 1 && c) {
        const idx = this.idx(r + 1, c - 1, sl - 1, dim)
        if (val === bw[idx]) {
          nabo[nr_set++] = il[idx]
        }
      }
      if (r && c < dim[1] - 1) {
        const idx = this.idx(r - 1, c + 1, sl - 1, dim)
        if (val === bw[idx]) {
          nabo[nr_set++] = il[idx]
        }
      }
      if (r < dim[0] - 1 && c < dim[1] - 1) {
        const idx = this.idx(r + 1, c + 1, sl - 1, dim)
        if (val === bw[idx]) {
          nabo[nr_set++] = il[idx]
        }
      }
    }
    if (nr_set) {
      this.fill_tratab(tt, nabo, nr_set, tn)
      return nabo[0]
    } else {
      return 0
    }
  } // check_previous_slice()

  // provisionally label all voxels in volume
  do_initial_labelling(bw, dim, conn) {
    const naboPS = new Uint32Array(32)
    const tn = new Uint32Array(32)
    let label = 1
    const kGrowArrayBy = 8192
    let ttn = kGrowArrayBy
    let tt = new Uint32Array(ttn).fill(0)
    const il = new Uint32Array(dim[0] * dim[1] * dim[2]).fill(0)
    const nabo = new Uint32Array(27)
    for (let sl = 0; sl < dim[2]; sl++) {
      for (let c = 0; c < dim[1]; c++) {
        for (let r = 0; r < dim[0]; r++) {
          let nr_set = 0
          const val = bw[this.idx(r, c, sl, dim)]
          if (val === 0) {
            continue
          }
          nabo[0] = this.check_previous_slice(bw, il, r, c, sl, dim, conn, tt, naboPS, tn)
          if (nabo[0]) {
            nr_set += 1
          }
          if (conn >= 6) {
            if (r) {
              const idx = this.idx(r - 1, c, sl, dim)
              if (val === bw[idx]) {
                nabo[nr_set++] = il[idx]
              }
            }
            if (c) {
              const idx = this.idx(r, c - 1, sl, dim)
              if (val === bw[idx]) {
                nabo[nr_set++] = il[idx]
              }
            }
          }
          if (conn >= 18) {
            if (c && r) {
              const idx = this.idx(r - 1, c - 1, sl, dim)
              if (val === bw[idx]) {
                nabo[nr_set++] = il[idx]
              }
            }
            if (c && r < dim[0] - 1) {
              const idx = this.idx(r + 1, c - 1, sl, dim)
              if (val === bw[idx]) {
                nabo[nr_set++] = il[idx]
              }
            }
          }
          if (nr_set) {
            il[this.idx(r, c, sl, dim)] = nabo[0]
            this.fill_tratab(tt, nabo, nr_set, tn)
          } else {
            il[this.idx(r, c, sl, dim)] = label
            if (label >= ttn) {
              ttn += kGrowArrayBy
              const ext = new Uint32Array(ttn)
              ext.set(tt)
              tt = ext
            }
            tt[label - 1] = label
            label++
          }
        }
      }
    }
    for (let i = 0; i < label - 1; i++) {
      let j = i
      while (tt[j] !== j + 1) {
        j = tt[j] - 1
      }
      tt[i] = j + 1
    }
    return [label - 1, tt, il]
  } // do_initial_labelling()

  // translation table unifies a region that has been assigned multiple classes
  fill_tratab(tt, nabo, nr_set, tn) {
    // let cntr = 0
    //tn.fill(0)
    const INT_MAX = 2147483647
    let ltn = INT_MAX
    for (let i = 0; i < nr_set; i++) {
      let j = nabo[i]
      // cntr = 0
      while (tt[j - 1] !== j) {
        j = tt[j - 1]
        /* cntr++
        if (cntr > 100) {
          console.log('\nOoh no!!')
          break
        } */
      }
      tn[i] = j
      ltn = Math.min(ltn, j)
    }
    for (let i = 0; i < nr_set; i++) {
      tt[tn[i] - 1] = ltn
    }
  } // fill_tratab()

  // remove any residual gaps so label numbers are dense rather than sparse
  translate_labels(il, dim, tt, ttn) {
    const nvox = dim[0] * dim[1] * dim[2]
    let ml = 0
    const l = new Uint32Array(nvox).fill(0)
    for (let i = 0; i < ttn; i++) {
      ml = Math.max(ml, tt[i])
    }
    const fl = new Uint32Array(ml).fill(0)
    let cl = 0
    for (let i = 0; i < nvox; i++) {
      if (il[i]) {
        if (!fl[tt[il[i] - 1] - 1]) {
          cl += 1
          fl[tt[il[i] - 1] - 1] = cl
        }
        l[i] = fl[tt[il[i] - 1] - 1]
      }
    }
    return [cl, l]
  } // translate_labels()

  /**
   * For each SUPPRESSED component, find the most common KEPT class touching its
   * 6-neighbourhood boundary. Used by the relabel-instead-of-zero option so a
   * dropped blob inherits its surrounding surviving label rather than becoming
   * background.
   * @param {Uint32Array} ls   Component-label map (0 = background).
   * @param {number[]} dim     [nx, ny, nz].
   * @param {Uint32Array} kept Per-label surviving class id (>0) or 0 if suppressed.
   * @param {number} cl        Number of components.
   * @returns {Uint32Array}    winner[comp] = class to assign (0 = leave as bg).
   */
  neighbor_winners(ls, dim, kept, cl) {
    const nx = dim[0]
    const ny = dim[1]
    const nz = dim[2]
    const sliceXY = nx * ny
    // hist: compId -> Map(class -> contact count)
    const hist = new Map()
    const bump = (c, klass) => {
      let h = hist.get(c)
      if (!h) {
        h = new Map()
        hist.set(c, h)
      }
      h.set(klass, (h.get(klass) || 0) + 1)
    }
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = z * sliceXY + y * nx + x
          const c = ls[i]
          if (c === 0 || kept[c]) {
            continue
          } // only suppressed (non-bg, not-kept) voxels
          let k
          if (x > 0 && (k = kept[ls[i - 1]])) bump(c, k)
          if (x < nx - 1 && (k = kept[ls[i + 1]])) bump(c, k)
          if (y > 0 && (k = kept[ls[i - nx]])) bump(c, k)
          if (y < ny - 1 && (k = kept[ls[i + nx]])) bump(c, k)
          if (z > 0 && (k = kept[ls[i - sliceXY]])) bump(c, k)
          if (z < nz - 1 && (k = kept[ls[i + sliceXY]])) bump(c, k)
        }
      }
    }
    const winner = new Uint32Array(cl + 1).fill(0)
    for (const [c, h] of hist) {
      let best = 0
      let bestN = 0
      for (const [klass, n] of h) {
        // most contacts wins; ties broken by lower class id for determinism
        if (n > bestN || (n === bestN && (best === 0 || klass < best))) {
          bestN = n
          best = klass
        }
      }
      winner[c] = best
    }
    return winner
  }

  /**
   * Build the final class volume from a keep decision.
   * @param {Uint32Array} ls   Component-label map (0 = background).
   * @param {number[]} dim     [nx, ny, nz] (required when relabelSuppressed).
   * @param {Uint32Array} kept Per-label surviving class id (>0) or 0 if suppressed.
   * @param {number} cl        Number of components.
   * @param {boolean} relabelSuppressed If true, suppressed components inherit the
   *   most common kept neighbour class instead of becoming background. Components
   *   touching no kept voxel (e.g. specks floating in true exterior background)
   *   still become 0.
   * @returns {[number, Uint32Array]} [maxClass, volume].
   */
  finalize_volume(ls, dim, kept, cl, relabelSuppressed) {
    const nvox = ls.length
    const vxs = new Uint32Array(nvox).fill(0)
    const winner = relabelSuppressed ? this.neighbor_winners(ls, dim, kept, cl) : null
    let mxbw = 0
    for (let i = 0; i < nvox; i++) {
      const c = ls[i]
      if (c === 0) {
        continue
      }
      let v = kept[c]
      if (!v && winner) {
        v = winner[c]
      }
      if (v) {
        vxs[i] = v
        if (v > mxbw) {
          mxbw = v
        }
      }
    }
    return [mxbw, vxs]
  }

  /**
   * DIAGNOSTIC ONLY — does not modify the volume. Logs, per connected component,
   * its class id, size, whether it's the largest component of its class, how many
   * components its class fragments into, and what its surface touches (dominant
   * neighbouring class + how enclosed it is by that class, plus background
   * fraction). Use it to decide whether a stray region (e.g. a red blob inside
   * green) is a separate label swallowed by one neighbour (enclosure ~1, small,
   * not largest-of-class) vs. a connected protrusion of a large structure
   * (its class has 1 component / it IS the largest-of-class).
   *
   * @param {Uint32Array} bw   Original per-voxel class values.
   * @param {number} cl        Number of components.
   * @param {Uint32Array} ls   Component-label map (0 = background).
   * @param {number[]} dim     [nx, ny, nz].
   * @param {object} [options] { topN=50, minSize=1, label='diag' }.
   * @returns {object[]} the per-component rows (also printed via console.table).
   */
  diagnose_components(bw, cl, ls, dim, options = {}) {
    const topN = options.topN ?? 50
    const minSize = options.minSize ?? 1
    const tag = options.label ?? 'diag'
    const nx = dim[0]
    const ny = dim[1]
    const nz = dim[2]
    const sliceXY = nx * ny

    const ls2bw = new Uint32Array(cl + 1)
    const sumls = new Uint32Array(cl + 1)
    for (let i = 0; i < bw.length; i++) {
      const c = ls[i]
      if (c) {
        ls2bw[c] = bw[i]
        sumls[c]++
      }
    }

    // Per-component: histogram of FOREIGN neighbour classes, background contacts,
    // and total boundary-voxel contacts (neighbour is a different component/bg).
    const fhist = new Map()
    const bgContacts = new Uint32Array(cl + 1)
    const totalBoundary = new Uint32Array(cl + 1)
    const bump = (c, k) => {
      let h = fhist.get(c)
      if (!h) {
        h = new Map()
        fhist.set(c, h)
      }
      h.set(k, (h.get(k) || 0) + 1)
    }
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = z * sliceXY + y * nx + x
          const c = ls[i]
          if (!c) {
            continue
          }
          const myClass = ls2bw[c]
          const check = (j) => {
            const nc = ls[j]
            if (nc === c) {
              return
            } // interior (same component) — not a boundary face
            totalBoundary[c]++
            const ncl = nc ? ls2bw[nc] : 0
            if (ncl === 0) {
              bgContacts[c]++
            } else if (ncl !== myClass) {
              bump(c, ncl)
            } // foreign-class face
          }
          if (x > 0) check(i - 1)
          if (x < nx - 1) check(i + 1)
          if (y > 0) check(i - nx)
          if (y < ny - 1) check(i + nx)
          if (z > 0) check(i - sliceXY)
          if (z < nz - 1) check(i + sliceXY)
        }
      }
    }

    const classCount = new Map()
    const classMax = new Map()
    for (let c = 1; c <= cl; c++) {
      const cls = ls2bw[c]
      classCount.set(cls, (classCount.get(cls) || 0) + 1)
      if (!classMax.has(cls) || sumls[c] > classMax.get(cls)) {
        classMax.set(cls, sumls[c])
      }
    }

    const rows = []
    for (let c = 1; c <= cl; c++) {
      if (sumls[c] < minSize) {
        continue
      }
      const cls = ls2bw[c]
      const h = fhist.get(c)
      let dom = 0
      let domN = 0
      let foreignTotal = 0
      if (h) {
        for (const [k, n] of h) {
          foreignTotal += n
          if (n > domN) {
            domN = n
            dom = k
          }
        }
      }
      const tb = totalBoundary[c] || 1
      rows.push({
        comp: c,
        class: cls,
        size: sumls[c],
        largestOfClass: sumls[c] === classMax.get(cls) ? 'Y' : 'n',
        compsInClass: classCount.get(cls),
        domNeighbor: dom,
        domFracForeign: foreignTotal ? +(domN / foreignTotal).toFixed(2) : 0,
        domFracBoundary: +(domN / tb).toFixed(2),
        bgFrac: +(bgContacts[c] / tb).toFixed(2)
      })
    }
    // Islands first: most enclosed by a single foreign class, largest of those first.
    rows.sort((a, b) => b.domFracForeign - a.domFracForeign || b.size - a.size)

    // Plain-text tables via console.log: console.table does NOT render from a
    // Web Worker (where inference may run) and is hidden when the console's
    // "Info" level is off. Text also avoids the (slow) table-render cost.
    const fmt = (rws, cols) => {
      const widths = cols.map((c) => Math.max(c.h.length, ...rws.map((r) => String(r[c.k]).length)))
      const line = (cells) => cells.map((s, i) => String(s).padStart(widths[i])).join('  ')
      return [line(cols.map((c) => c.h)), ...rws.map((r) => line(cols.map((c) => r[c.k])))].join('\n')
    }
    const compCols = [
      { k: 'comp', h: 'comp' }, { k: 'class', h: 'class' }, { k: 'size', h: 'size' },
      { k: 'largestOfClass', h: 'lrg' }, { k: 'compsInClass', h: 'nComp' },
      { k: 'domNeighbor', h: 'domNbr' }, { k: 'domFracForeign', h: 'encF' },
      { k: 'domFracBoundary', h: 'encB' }, { k: 'bgFrac', h: 'bgF' }
    ]
    console.log(
      `[${tag}] total components=${cl}, distinct classes=${classCount.size}\n` +
        `[${tag}] island candidates (encF≈1 + small size + lrg=n ⇒ swallowed island):\n` +
        fmt(rows.slice(0, topN), compCols)
    )

    const classRows = [...classCount.entries()]
      .map(([cls, cnt]) => ({ class: cls, components: cnt, maxCompSize: classMax.get(cls) }))
      .sort((a, b) => b.components - a.components)
    console.log(
      `[${tag}] per-class component counts (components=1 ⇒ fully connected):\n` +
        fmt(classRows.slice(0, 30), [
          { k: 'class', h: 'class' }, { k: 'components', h: 'comps' }, { k: 'maxCompSize', h: 'maxSize' }
        ])
    )

    return rows
  }

  // retain only the largest cluster for each region
  // dim + relabelSuppressed are optional: when relabelSuppressed is true, blobs
  // that lose the per-class "largest" contest are repainted with their
  // surrounding surviving label instead of background (requires dim).
  largest_original_cluster_labels(bw, cl, ls, dim = null, relabelSuppressed = false) {
    const nvox = bw.length
    const ls2bw = new Uint32Array(cl + 1).fill(0)
    const sumls = new Uint32Array(cl + 1).fill(0)
    for (let i = 0; i < nvox; i++) {
      const bwVal = bw[i]
      const lsVal = ls[i]
      ls2bw[lsVal] = bwVal
      sumls[lsVal]++
    }
    for (let i = 0; i < cl + 1; i++) {
      const bwVal = ls2bw[i]
      // see if this is largest cluster of this bw-value
      for (let j = 0; j < cl + 1; j++) {
        if (j === i) {
          continue
        }
        if (bwVal !== ls2bw[j]) {
          continue
        }
        if (sumls[i] < sumls[j]) {
          ls2bw[i] = 0
        } else if (sumls[i] === sumls[j] && i < j) {
          ls2bw[i] = 0
        } // ties: arbitrary winner
      }
    }
    // ls2bw now holds the surviving class per label (0 for suppressed). Reuse it
    // directly as the `kept` map for finalize_volume.
    return this.finalize_volume(ls, dim, ls2bw, cl, relabelSuppressed)
  }

  // Filter clusters based on target classes rules
  // targetClasses: 'all', or Set of class IDs.
  // If 'all' or class in targetClasses: keep only largest component of that class.
  // Else: keep all components of that class.
  filter_clusters(bw, cl, ls, targetClasses, dim = null, relabelSuppressed = false) {
    const nvox = bw.length
    const ls2bw = new Uint32Array(cl + 1).fill(0)
    const sumls = new Uint32Array(cl + 1).fill(0)

    // 1. Map labels to original classes and count sizes
    for (let i = 0; i < nvox; i++) {
      const bwVal = bw[i]
      const lsVal = ls[i]
      // Only track if non-background (assuming 0 is bg)
      if (lsVal > 0) {
        ls2bw[lsVal] = bwVal
        sumls[lsVal]++
      }
    }

    // 2. Determine which components to keep
    const keepLabel = new Uint8Array(cl + 1).fill(1) // Default keep

    // For each component i
    for (let i = 1; i <= cl; i++) {
      const bwVal = ls2bw[i]

      // Check if we should filter this class
      const shouldFilter = (targetClasses === 'all') || (targetClasses.has && targetClasses.has(bwVal));

      if (shouldFilter) {
        // Check if there is a larger component j with same bwVal
        for (let j = 1; j <= cl; j++) {
          if (i === j) continue;
          if (ls2bw[j] !== bwVal) continue;

          if (sumls[j] > sumls[i]) {
            keepLabel[i] = 0; // Suppress smaller
            break;
          } else if (sumls[j] === sumls[i] && j < i) { // Tie-break
            // maintain strictly one
            // Convention: keep lower index if sizes equal?
            // Logic in original was: if (i < j) zero out i? No.
            // Original: if (sumls[i] == sumls[j] && i < j) ls2bw[i] = 0.
            // This means if i < j, i is removed. So j is kept. larger index wins?
            // Let's stick to original logic:
            // "if (sumls[i] === sumls[j] && i < j) { ls2bw[i] = 0 }"
            // Wait, if i < j, loop reaches j later.
            // When checking i: compare with j. if equal and i < j, kill i.
            // When checking j: compare with i. if equal and j > i, (j !< i) so don't kill j?
            // Correct. Larger index keeps.
            keepLabel[i] = 0;
            break;
          }
        }
      }
    }

    // 3. Reconstruct: kept[c] = surviving class id, or 0 if suppressed.
    const kept = new Uint32Array(cl + 1).fill(0)
    for (let i = 1; i <= cl; i++) {
      if (keepLabel[i]) kept[i] = ls2bw[i]
    }
    return this.finalize_volume(ls, dim, kept, cl, relabelSuppressed)
  }

  /**
   * Filter clusters based on a size ratio threshold relative to the largest cluster for that class.
   * Logic:
   * 1. Find max size for each class.
   * 2. Keep component if size >= max_size_of_class * minRatio.
   * @param {Uint32Array} bw - Original voxel values (unused directly for filtering decision logic but used for return)
   * @param {number} cl - Number of regions
   * @param {Uint32Array} ls - Label map
   * @param {number} minRatio - Threshold (e.g. 0.3)
   */
  filter_clusters_by_ratio(bw, cl, ls, minRatio, dim = null, relabelSuppressed = false) {
    const nvox = bw.length
    const ls2bw = new Uint32Array(cl + 1).fill(0)
    const sumls = new Uint32Array(cl + 1).fill(0)

    // 1. Map labels to original classes and count sizes
    for (let i = 0; i < nvox; i++) {
      // ls[i] is component label
      const comp = ls[i]
      if (comp > 0) {
        // Mapping check (assuming consistent labeling)
        if (ls2bw[comp] === 0) ls2bw[comp] = bw[i];
        sumls[comp]++;
      }
    }

    // 2. Determine Max Size per Class
    // Map: ClassID -> MaxSize
    const classMaxSize = new Map();
    for (let i = 1; i <= cl; i++) {
      const classID = ls2bw[i];
      const size = sumls[i];
      if (!classMaxSize.has(classID) || size > classMaxSize.get(classID)) {
        classMaxSize.set(classID, size);
      }
    }

    // 3. Determine validity
    const keepLabel = new Uint8Array(cl + 1).fill(0);
    for (let i = 1; i <= cl; i++) {
      const classID = ls2bw[i];
      const size = sumls[i];
      const maxSize = classMaxSize.get(classID) || 0;

      if (size >= maxSize * minRatio) {
        keepLabel[i] = 1;
      }
    }

    // 4. Reconstruct: kept[c] = surviving class id, or 0 if suppressed.
    const kept = new Uint32Array(cl + 1).fill(0)
    for (let i = 1; i <= cl; i++) {
      if (keepLabel[i]) kept[i] = ls2bw[i]
    }
    return this.finalize_volume(ls, dim, kept, cl, relabelSuppressed)
  }

  // given a 3D image, return a clustered label map
  // for an explanation and optimized C code see
  // https://github.com/seung-lab/connected-components-3d
  bwlabel(img, dim, conn = 26, binarize = false, onlyLargestClusterPerClass = false) {
    const start = Date.now()
    const nvox = dim[0] * dim[1] * dim[2]
    const bw = new Uint32Array(nvox).fill(0)
    if (![6, 18, 26].includes(conn)) {
      console.log('bwlabel: conn must be 6, 18 or 26.')
      return [0, bw]
    }
    if (dim[0] < 2 || dim[1] < 2 || dim[2] < 1) {
      console.log('bwlabel: img must be 2 or 3-dimensional')
      return [0, bw]
    }
    if (binarize) {
      for (let i = 0; i < nvox; i++) {
        if (img[i] !== 0.0) {
          bw[i] = 1
        }
      }
    } else {
      bw.set(img)
    }
    let [ttn, tt, il] = this.do_initial_labelling(bw, dim, conn)
    if (tt === undefined) {
      tt = new Uint32Array(0)
    }
    const [cl, ls] = this.translate_labels(il, dim, tt, ttn)
    console.log(conn + ' neighbor clustering into ' + cl + ' regions in ' + (Date.now() - start) + 'ms')
    if (onlyLargestClusterPerClass) {
      const [nbw, bwMx] = this.largest_original_cluster_labels(bw, cl, ls)
      return [nbw, bwMx]
    }
    return [cl, ls]
  } // bwlabel()

  /**
   * Filter clusters based on rank (keep top K largest per class).
   * @param {Uint32Array} bw - Original voxel values (unused directly for filtering decision logic but used for return)
   * @param {number} cl - Number of regions
   * @param {Uint32Array} ls - Label map
   * @param {number} maxRank - Max number of components to keep per class (e.g. 2)
   */
  filter_clusters_by_rank(bw, cl, ls, maxRank, minRatio = 0, dim = null, relabelSuppressed = false, nearBrainMaxGap = null, diag = false) {
    const nvox = bw.length
    const ls2bw = new Uint32Array(cl + 1).fill(0)
    const sumls = new Uint32Array(cl + 1).fill(0)

    // Spatial gate (`nearBrainMaxGap`, in VOXELS): a NON-largest kept component
    // is retained only if the gap between its bounding box and the MAIN BRAIN's
    // bounding box is <= this many voxels. A genuinely detached cerebellum
    // touches the cerebrum (gap ~= 0) and survives; a phantom blob outside the
    // head is separated by a real gap and is dropped. Unlike a centroid-in-
    // expanded-bbox test, a bbox GAP does not depend on the brain's size
    // (the brain bbox fills most of a 256^3 head, which made the expanded-bbox
    // test a near no-op). Disabled (null) -> original rank-only behavior.
    const useDist = nearBrainMaxGap != null && Array.isArray(dim) && dim.length === 3;
    // Decode a linear index to (A, B, C) using the SAME convention as idx():
    // idx = C*DIM0*DIM1 + B*DIM0 + A, i.e. A is the fastest-varying axis.
    const D0 = useDist ? dim[0] : 0;
    const D1 = useDist ? dim[1] : 0;
    const minA = useDist ? new Int32Array(cl + 1).fill(2147483647) : null;
    const maxA = useDist ? new Int32Array(cl + 1).fill(-1) : null;
    const minB = useDist ? new Int32Array(cl + 1).fill(2147483647) : null;
    const maxB = useDist ? new Int32Array(cl + 1).fill(-1) : null;
    const minC = useDist ? new Int32Array(cl + 1).fill(2147483647) : null;
    const maxC = useDist ? new Int32Array(cl + 1).fill(-1) : null;

    // 1. Map labels to original classes, count sizes, accumulate per-comp bbox
    for (let i = 0; i < nvox; i++) {
      const comp = ls[i]
      if (comp > 0) {
        if (ls2bw[comp] === 0) ls2bw[comp] = bw[i];
        sumls[comp]++;
        if (useDist) {
          const a = i % D0;
          const t = (i / D0) | 0;
          const b = t % D1;
          const c = (t / D1) | 0;
          if (a < minA[comp]) minA[comp] = a; if (a > maxA[comp]) maxA[comp] = a;
          if (b < minB[comp]) minB[comp] = b; if (b > maxB[comp]) maxB[comp] = b;
          if (c < minC[comp]) minC[comp] = c; if (c > maxC[comp]) maxC[comp] = c;
        }
      }
    }

    // Spatial gate setup: find the globally-largest component (the brain), then
    // measure each candidate's SURFACE distance to it -- the shortest path of
    // voxels (through any space) from the candidate to the brain, via a
    // multi-source 6-connected BFS from all brain voxels. A detached cerebellum
    // nearly touches the cerebrum (a few voxels of CSF), so its surface distance
    // is small; a phantom blob outside the head is separated by a large empty
    // gap. NOTE: a bounding-box gap fails here -- the cerebrum bbox fills most of
    // the head and ENCLOSES the phantom's region, giving a misleading gap of 0;
    // surface distance measures the actual empty separation instead.
    let surfDist = null;  // Float64Array(cl+1): min BFS distance of each comp to brain
    let brainComp = 0;
    if (useDist) {
      let brainSize = -1;
      for (let i = 1; i <= cl; i++) {
        if (sumls[i] > brainSize) { brainSize = sumls[i]; brainComp = i; }
      }
      // City-block BFS, capped a few layers beyond the threshold (monotonic, so
      // the cap is all the gate needs). dist = -1 stays "farther than the cap".
      const MAX_SCAN = Math.max(2, Math.ceil(nearBrainMaxGap) + 4);
      const D0D1 = D0 * D1;
      const dist = new Int16Array(nvox).fill(-1);
      let frontier = [];
      for (let i = 0; i < nvox; i++) {
        if (ls[i] === brainComp) { dist[i] = 0; frontier.push(i); }
      }
      for (let d = 1; d <= MAX_SCAN && frontier.length; d++) {
        const next = [];
        for (let f = 0; f < frontier.length; f++) {
          const v = frontier[f];
          const a = v % D0;
          const t = (v / D0) | 0;
          const b = t % D1;
          if (a > 0 && dist[v - 1] === -1) { dist[v - 1] = d; next.push(v - 1); }
          if (a < D0 - 1 && dist[v + 1] === -1) { dist[v + 1] = d; next.push(v + 1); }
          if (b > 0 && dist[v - D0] === -1) { dist[v - D0] = d; next.push(v - D0); }
          if (b < D1 - 1 && dist[v + D0] === -1) { dist[v + D0] = d; next.push(v + D0); }
          if (v - D0D1 >= 0 && dist[v - D0D1] === -1) { dist[v - D0D1] = d; next.push(v - D0D1); }
          if (v + D0D1 < nvox && dist[v + D0D1] === -1) { dist[v + D0D1] = d; next.push(v + D0D1); }
        }
        frontier = next;
      }
      // Per-component minimum distance to the brain (FAR if beyond the scan cap).
      const FAR = MAX_SCAN + 1;
      surfDist = new Float64Array(cl + 1).fill(FAR);
      for (let i = 0; i < nvox; i++) {
        const comp = ls[i];
        if (comp > 0 && comp !== brainComp) {
          const dd = dist[i] >= 0 ? dist[i] : FAR;
          if (dd < surfDist[comp]) surfDist[comp] = dd;
        }
      }
      if (diag) {
        console.log(`[rank-filter] brain comp=${brainComp} size=${brainSize} ` +
          `bbox A[${minA[brainComp]},${maxA[brainComp]}] B[${minB[brainComp]},${maxB[brainComp]}] C[${minC[brainComp]},${maxC[brainComp]}] | maxGap=${nearBrainMaxGap} scan=${MAX_SCAN}`);
      }
    }

    // 2. Group components by Class ID
    const classComponents = new Map(); // ClassID -> [{compID, size}, ...]
    for (let i = 1; i <= cl; i++) {
      const classID = ls2bw[i];
      const size = sumls[i];
      if (!classComponents.has(classID)) {
        classComponents.set(classID, []);
      }
      classComponents.get(classID).push({ i, size });
    }

    // 3. Mark which components to keep
    const keepLabel = new Uint8Array(cl + 1).fill(0);

    for (const [classID, components] of classComponents.entries()) {
      // Sort descending by size
      components.sort((a, b) => b.size - a.size);

      // Optional size floor: keep a top-K component only if it is at least
      // `minRatio` of the LARGEST component in its class. This drops tiny stray
      // blobs that happen to land within the top-K (e.g. a misclassified chin
      // speck) while preserving large detached structures such as a separated
      // cerebellum, which sits far above the floor. The largest component
      // (k=0, ratio 1.0) always passes. Components are size-sorted, so once one
      // falls below the floor every later one does too -> break. minRatio=0
      // (default) preserves the original rank-only behavior.
      const largest = components.length ? components[0].size : 0;
      const sizeFloor = minRatio > 0 ? largest * minRatio : 0;

      // Keep top K (subject to the size floor). The per-class largest (k=0) is
      // always kept; secondary kept components must also pass the spatial gate
      // (when enabled) so far-away phantoms are dropped but a detached
      // cerebellum (touching the brain, gap ~= 0) survives.
      const count = Math.min(components.length, maxRank);
      for (let k = 0; k < count; k++) {
        const comp = components[k];
        if (comp.size < sizeFloor) {
          if (diag && k > 0) console.log(`[rank-filter] class ${classID} #${k}: size=${comp.size} DROP (below ${(minRatio*100).toFixed(0)}% floor)`);
          break;
        }
        if (k > 0 && useDist) {
          const g = surfDist[comp.i];
          const pass = g <= nearBrainMaxGap;
          if (diag) console.log(`[rank-filter] class ${classID} #${k}: size=${comp.size} surfDist=${g} -> ${pass ? 'KEEP' : 'DROP (too far)'}`);
          if (!pass) continue;
        }
        keepLabel[comp.i] = 1;
      }
    }

    // 4. Reconstruct: kept[c] = surviving class id, or 0 if suppressed.
    const kept = new Uint32Array(cl + 1).fill(0)
    for (let i = 1; i <= cl; i++) {
      if (keepLabel[i]) kept[i] = ls2bw[i]
    }
    return this.finalize_volume(ls, dim, kept, cl, relabelSuppressed)
  }
}
