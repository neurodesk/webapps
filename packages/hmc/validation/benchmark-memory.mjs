// Sample the measured host externally, including input preparation. This is observed
// process-tree RSS, not private memory: Chromium's shared pages can be counted twice.
import { execFileSync } from 'node:child_process';

export function processTreeRss(pid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const selected = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [child, parent] of rows) {
      if (selected.has(parent) && !selected.has(child)) {
        selected.add(child);
        changed = true;
      }
    }
  }
  return rows.filter(([child]) => selected.has(child)).reduce((sum, [, , kib]) => sum + kib * 1024, 0);
}

export function sampleProcessMemory(pid, {
  readRss = processTreeRss,
  now = () => performance.now(),
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  const samples = [];
  const started = now();
  let stopped = false;
  const sample = () => {
    if (stopped) return samples.at(-1).bytes;
    const bytes = readRss(pid);
    samples.push({ elapsedMs: now() - started, bytes });
    return bytes;
  };
  sample();
  const timer = schedule(sample, 100);
  return {
    sample,
    stop() {
      if (!stopped) {
        sample();
        stopped = true;
        cancel(timer);
      }
      return {
        baselineBytes: samples[0].bytes,
        peakBytes: Math.max(...samples.map(value => value.bytes)),
        samples: [...samples],
      };
    },
  };
}
