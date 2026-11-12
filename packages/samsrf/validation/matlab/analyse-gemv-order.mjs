// Reduction trees of single y' * A from a record_gemv_order.m recording, checked
// against the recording's random products of the same shapes.
// Usage: analyse-gemv-order.mjs RECORDING_DIR [OUTPUT_JSON]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const f32 = Math.fround;

// Rebuild one column's binary reduction tree from pair subtree sizes. A node is
// a leaf index or [left, right]; addition is commutative, so the order of the
// two children does not change a result.
export function reconstructTree(n, pairs, sizes) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const node = Array.from({ length: n }, (_, i) => i);
  const count = Array(n).fill(1);
  const order = pairs.map((pair, index) => ({ pair, size: sizes[index] })).sort((a, b) => a.size - b.size);
  for (const { pair, size } of order) {
    const a = find(pair[0]);
    const b = find(pair[1]);
    if (a === b) continue;
    // The smallest subtree holding both leaves joins exactly their two clusters.
    assert.equal(count[a] + count[b], size, `pair ${pair} needs a subtree of ${size} leaves, not ${count[a] + count[b]}`);
    parent[b] = a;
    node[a] = [node[a], node[b]];
    count[a] += count[b];
  }
  const root = find(0);
  assert.equal(count[root], n, 'The pairs do not join every leaf');
  return node[root];
}

export function evaluateTree(tree, terms) {
  return Array.isArray(tree) ? f32(evaluateTree(tree[0], terms) + evaluateTree(tree[1], terms)) : terms[tree];
}

// single(a + b) for a double a and a single b, rounded once: the double sum is
// corrected when it lands on a single rounding midpoint.
function addRoundedOnce(a, b) {
  const sum = a + b;
  const rounded = f32(sum);
  const virtual = sum - a;
  const error = (a - (sum - virtual)) + (b - virtual);
  if (error === 0 || rounded === sum) return rounded;
  const other = sum > rounded ? nextUp(rounded) : nextDown(rounded);
  if (Math.abs(other - sum) !== Math.abs(rounded - sum)) return rounded;
  // A tie in double: the exact sum lies on the side of the error.
  return (error > 0) === (other > rounded) ? other : rounded;
}

const bits = new Float32Array(1);
const words = new Uint32Array(bits.buffer);
function step(value, direction) {
  bits[0] = value;
  if (value === 0) words[0] = direction > 0 ? 1 : 0x80000001;
  else if ((value > 0) === (direction > 0)) words[0] += 1;
  else words[0] -= 1;
  return bits[0];
}
const nextUp = (value) => step(value, 1);
const nextDown = (value) => step(value, -1);

// With FMA, a leaf joins its accumulator as the exact product (products[i], a
// double holding the product of two singles exactly); two leaves start a chain
// as single(p_left) and then fma(p_right).
export function evaluateTreeFma(tree, products) {
  if (!Array.isArray(tree)) return f32(products[tree]);
  const [left, right] = tree;
  if (!Array.isArray(right)) return addRoundedOnce(products[right], evaluateTreeFma(left, products));
  if (!Array.isArray(left)) return addRoundedOnce(products[left], evaluateTreeFma(right, products));
  return f32(evaluateTreeFma(left, products) + evaluateTreeFma(right, products));
}

// Leaves in left-to-right order with their depth, for describing a tree.
export function leafDepths(tree, depth = 0, out = []) {
  if (Array.isArray(tree)) {
    leafDepths(tree[0], depth + 1, out);
    leafDepths(tree[1], depth + 1, out);
  } else {
    out.push([tree, depth]);
  }
  return out;
}

const column = (matrix, j) => matrix.map((row) => row[j]);
const rows = (value) => (Array.isArray(value[0]) ? value : value.map((entry) => [entry]));

export function analyseGemvOrder(recording) {
  return recording.cases.map((item) => {
    const n = item.n;
    const m = item.m;
    const pairs = rows(item.pairs).map(([i, k]) => [i - 1, k - 1]);
    const counts = rows(item.counts);
    const trees = [];
    for (let j = 0; j < m; j += 1) trees.push(reconstructTree(n, pairs, column(counts, j).map((c) => n - c)));
    // A double accumulator (as OpenBLAS's sdot uses) does not absorb the ones,
    // so its counts form no tree.
    let columnTree;
    try {
      columnTree = reconstructTree(n, pairs, rows(item.column).map(([c]) => n - c));
    } catch (error) {
      columnTree = { error: error.message };
    }
    const ys = rows(item.ys);
    const As = rows(item.As);
    const products = rows(item.products);
    let equal = 0;
    let equalFma = 0;
    let total = 0;
    for (let d = 0; d < products.length; d += 1) {
      for (let j = 0; j < m; j += 1) {
        const exact = Array.from({ length: n }, (_, i) => f32(ys[i][d]) * f32(As[i][d * m + j]));
        const terms = exact.map(f32);
        if (Object.is(evaluateTree(trees[j], terms), products[d][j])) equal += 1;
        if (Object.is(evaluateTreeFma(trees[j], exact), products[d][j])) equalFma += 1;
        total += 1;
      }
    }
    const distinct = new Set(trees.map((tree) => JSON.stringify(tree))).size;
    return { n, m, trees, columnTree, distinctColumnTrees: distinct, heldOut: { equal, equalFma, total } };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, output] = process.argv.slice(2);
  assert.ok(root, 'Usage: analyse-gemv-order.mjs RECORDING_DIR [OUTPUT_JSON]');
  const recording = JSON.parse(fs.readFileSync(path.join(root, 'gemv-order.json'), 'utf8'));
  const result = analyseGemvOrder(recording);
  for (const item of result) {
    const control = item.columnTree.error ? `no tree (${item.columnTree.error})` : 'a tree';
    console.log(`n=${item.n} m=${item.m}: ${item.distinctColumnTrees} distinct column trees; held-out products ${item.heldOut.equal} (FMA ${item.heldOut.equalFma})/${item.heldOut.total}; vector control: ${control}`);
  }
  if (output) fs.writeFileSync(output, JSON.stringify(result));
}
