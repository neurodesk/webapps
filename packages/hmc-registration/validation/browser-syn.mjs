// Browser-worker fit of the 1.2 mm SyN-SDC registration (#462). Runs the module worker
// (src/worker.js, unchanged, with the committed kernel) in Playwright's Chromium on the SyN
// antsRegistration call of REPLAY_RUN, a replay.sh output (the CI job's configuration), with its
// files read and named as ants-cli.mjs names them. The argv must equal the one the kernel recorded
// in REPLAY_RUN/wasm-calls.jsonl, and the outputs are compared with the replay's.
//
// Measured separately:
//   linear memory   WebAssembly.Memory byteLength in the worker. Before the first message, the
//                   worker scope's WebAssembly.Memory constructor and Memory.prototype.grow are
//                   wrapped to record each memory and each growth (time, pages, byteLength after).
//                   This observes; it does not change worker.js, the glue or the wasm bytes.
//   process RSS     /proc VmRSS, VmHWM, RssAnon, RssFile, RssShmem of every Chromium process under
//                   this Node process, sampled every 2 s and once more when the reply reaches the
//                   page, before the page hashes and uploads the outputs (at_reply); the worker
//                   runs in the page's renderer, and VmHWM is that process's peak so far.
//   UA memory       performance.measureUserAgentSpecificMemory() on the page right after that
//                   snapshot, as Chromium attributes it (the worker's scope included); recorded raw.
//                   Playwright's default headless shell does not provide it; set
//                   HMC_BROWSER_CHANNEL=chromium for the full Chromium of the same version.
// None of these is the allocator's live bytes or free headroom.
//
// full:   one SyN run to completion; outputs are uploaded to OUT/outputs and compared.
// cancel: start the SyN run, terminate the worker once the renderer's RSS has grown by 1 GB (or
//         after 600 s), sample RSS for 30 s, then run the package's rigid test pair in a new
//         worker and check native ANTs's bytes.
//
//   node validation/browser-syn.mjs full|cancel REPLAY_RUN OUT
//
// REPLAY_RUN must have run the committed kernel. Like test:browser, it needs a Playwright Chromium.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { HMC_REGISTRATION_WASM_SHA256 } from "../src/pin.js";
import { ARGV, NATIVE_MAT_SHA256 } from "../test/expected.mjs";
import { browserResultProblems } from "./browser-syn-result.mjs";

const [mode, replay, out] = process.argv.slice(2);
if (!["full", "cancel"].includes(mode) || !out) throw new Error("usage: node validation/browser-syn.mjs full|cancel REPLAY_RUN OUT");
const pkg = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
mkdirSync(join(out, "outputs"), { recursive: true });
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const note = (event) => {
  appendFileSync(join(out, "events.jsonl"), `${JSON.stringify({ t: now(), ...event })}\n`);
  console.log(JSON.stringify({ t: Math.round(now()), ...event }).slice(0, 400));
};

// The replay's SyN call, mapped as ants-cli.mjs maps it.
const lines = (file) => readFileSync(join(replay, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const synCall = lines("ants-calls.jsonl").find((c) => c.tool === "antsRegistration" && c.argv.includes("--transform"));
const recorded = lines("wasm-calls.jsonl").find((c) => c.program === "antsRegistration" && c.argv.includes("--transform"));
const files = {};
const names = new Map();
const mapPiece = (piece) => {
  const path = piece.trim();
  if (!path.startsWith("/") || !existsSync(path) || !statSync(path).isFile()) return piece;
  if (!names.has(path)) {
    const name = `in${names.size}_${basename(path)}`;
    names.set(path, name);
    files[name] = path;
  }
  return piece.replace(path, names.get(path));
};
const SYN_ARGV = synCall.argv.map((token) => token.split(/([[\],])/).map(mapPiece).join(""));
SYN_ARGV.push("--random-seed", recorded.argv[recorded.argv.indexOf("--random-seed") + 1]);
if (JSON.stringify(SYN_ARGV) !== JSON.stringify(recorded.argv)) throw new Error("the mapped argv differs from the kernel's record");
const inputs = Object.fromEntries(Object.entries(files).map(([name, path]) => [name, sha256(readFileSync(path))]));
const kernelSha = sha256(readFileSync(join(pkg, "wasm/hmc-registration.wasm")));
if (kernelSha !== HMC_REGISTRATION_WASM_SHA256) throw new Error("wasm/ is not the pinned kernel");
if (recorded.wasm_sha256 !== kernelSha) throw new Error(`REPLAY_RUN ran kernel ${recorded.wasm_sha256}, not ${kernelSha}`);

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = createServer((request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (request.method === "POST" && path.startsWith("/upload/")) {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => {
      writeFileSync(join(out, "outputs", basename(path)), Buffer.concat(chunks));
      response.end("ok");
    });
    return;
  }
  if (path === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>hmc-registration 1.2 mm SyN</title>");
    return;
  }
  let body;
  try {
    if (path.startsWith("/inputs/")) body = readFileSync(files[path.slice(8)]);
    else {
      const file = normalize(join(pkg, path));
      if (file.startsWith(pkg) && !file.split(sep).includes("node_modules")) body = readFileSync(file);
    }
  } catch {
    // A missing file is a 404 below.
  }
  if (!body) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader("Content-Type", TYPES[extname(path)] ?? "application/octet-stream");
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// Every Chromium process descended from this Node process.
function processes() {
  const parent = new Map();
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      parent.set(Number(pid), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      // The process exited after readdirSync listed it.
    }
  }
  const mine = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent) if (!mine.has(pid) && mine.has(ppid)) mine.add(pid), (grew = true);
  }
  mine.delete(process.pid);
  const rows = [];
  for (const pid of mine) {
    try {
      // Chromium rewrites its children's argv into one space-separated string.
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      if (!/chrom/.test(cmd.split(" ")[0])) continue;
      const status = Object.fromEntries(readFileSync(`/proc/${pid}/status`, "utf8").trim().split("\n").map((l) => l.split(/:\s+/)));
      const kb = (k) => Number.parseInt(status[k] ?? "0", 10);
      const type = cmd.match(/--type=([\w-]+)/)?.[1] ?? "browser";
      rows.push({ pid, type, rss_kb: kb("VmRSS"), hwm_kb: kb("VmHWM"), anon_kb: kb("RssAnon"), file_kb: kb("RssFile"), shmem_kb: kb("RssShmem") });
    } catch {
      // The process exited while it was being read.
    }
  }
  return rows;
}
const peaks = {};
let last = [];
function sample(label) {
  last = processes();
  for (const p of last) {
    const key = `${p.type}:${p.pid}`;
    peaks[key] = { ...p, rss_kb: Math.max(peaks[key]?.rss_kb ?? 0, p.rss_kb), hwm_kb: Math.max(peaks[key]?.hwm_kb ?? 0, p.hwm_kb) };
  }
  appendFileSync(join(out, "rss.jsonl"), `${JSON.stringify({ t: now(), label, processes: last })}\n`);
  return last;
}
const renderers = () => last.filter((p) => p.type === "renderer");
const rendererRss = () => renderers().reduce((s, p) => s + p.rss_kb, 0);
let label = "start";
const sampler = setInterval(() => sample(label), 2000);

let browser;
let page;
let atReply = null;

// A module worker running src/worker.js, with the observation wrappers installed before its first message.
async function startWorker(name) {
  const created = page.waitForEvent("worker");
  await page.evaluate((name) => {
    self.workers ??= {};
    self.workers[name] = new Worker("/src/worker.js", { type: "module" });
  }, name);
  const handle = await created;
  handle.on("close", () => note({ worker_closed: name }));
  await handle.evaluate(() => {
    const Memory = WebAssembly.Memory;
    const start = performance.now();
    self.__observed = { memories: [], grows: [] };
    const grow = Memory.prototype.grow;
    Memory.prototype.grow = function (delta) {
      const before = this.buffer.byteLength;
      const result = grow.call(this, delta);
      self.__observed.grows.push({ t: (performance.now() - start) / 1000, delta_pages: delta, before, after: this.buffer.byteLength });
      return result;
    };
    WebAssembly.Memory = new Proxy(Memory, {
      construct(target, args) {
        const memory = Reflect.construct(target, args);
        self.__observed.memories.push({ memory, descriptor: args[0] });
        return memory;
      },
    });
  });
  return handle;
}
const observed = (handle) =>
  handle.evaluate(() => ({
    memories: self.__observed.memories.map(({ memory, descriptor }) => ({ descriptor, byteLength: memory.buffer.byteLength, shared: memory.buffer instanceof SharedArrayBuffer })),
    grows: self.__observed.grows,
  }));

// Posts the SyN call; the page keeps the reply in self.replies[name] (outputs hashed and uploaded).
async function postSyn(name) {
  await page.evaluate(
    async ({ name, argv, names }) => {
      const inputs = {};
      for (const n of names) inputs[n] = new Uint8Array(await (await fetch(`/inputs/${n}`)).arrayBuffer());
      self.replies ??= {};
      self.replies[name] = new Promise((resolve) => {
        const posted = performance.now();
        self.workers[name].onmessage = async ({ data }) => {
          const wall = (performance.now() - posted) / 1000;
          await self.hmcReplyArrived();
          const ua = performance.measureUserAgentSpecificMemory
            ? await Promise.race([
                performance.measureUserAgentSpecificMemory().catch((e) => ({ error: String(e) })),
                new Promise((r) => setTimeout(() => r({ error: "timed out after 180 s" }), 180000)),
              ])
            : { error: "performance.measureUserAgentSpecificMemory is not defined" };
          const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
          const outputs = {};
          for (const [file, bytes] of Object.entries(data.outputs ?? {})) {
            outputs[file] = { bytes: bytes.byteLength, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)) };
            await fetch(`/upload/${file}`, { method: "POST", body: bytes });
          }
          resolve({ id: data.id, error: data.error ?? null, wall_s: wall, outputs, ua_memory: ua, log: data.log ?? [] });
        };
        self.workers[name].onerror = (event) => resolve({ error: `worker error: ${event.message}` });
      });
      const buffers = Object.values(inputs).map((b) => b.buffer);
      self.workers[name].postMessage({ id: 1, argv, inputs }, buffers);
    },
    { name, argv: SYN_ARGV, names: Object.keys(files) },
  );
}

const result = { mode, replay, kernel_sha256: kernelSha, argv: SYN_ARGV, inputs,
  replay_record: { wall_s: recorded.wall_s, wasm_heap_bytes: recorded.wasm_heap_bytes, heap_growth: recorded.heap_growth } };
let succeeded = false;
try {
  browser = await chromium.launch(process.env.HMC_BROWSER_CHANNEL ? { channel: process.env.HMC_BROWSER_CHANNEL } : {});
  page = await browser.newPage();
  await page.exposeFunction("hmcReplyArrived", () => {
    atReply = { t: now(), processes: sample("reply") };
  });
  page.on("pageerror", (error) => note({ pageerror: String(error) }));
  page.on("console", (message) => note({ console: message.text().slice(0, 300) }));
  await page.goto(`${origin}/`);
  if ((await page.evaluate(() => self.crossOriginIsolated)) !== true) throw new Error("not cross-origin isolated");
  const exe = (() => {
    const b = processes().find((p) => p.type === "browser");
    return b ? readlinkSync(`/proc/${b.pid}/exe`) : null;
  })();
  Object.assign(result, { browser: browser.version(), executable: exe });
  note({ browser: result.browser, executable: exe, kernel_sha256: kernelSha, origin });
  sample("idle");
  result.idle = { renderer_rss_kb: rendererRss(), processes: last };
  if (mode === "full") {
    const handle = await startWorker("syn");
    label = "syn";
    note({ posted: "syn" });
    await postSyn("syn");
    const reply = await page.evaluate(() => self.replies.syn);
    sample("syn-done");
    writeFileSync(join(out, "ants-log.txt"), `${(reply.log ?? []).join("\n")}\n`);
    delete reply.log;
    result.ua_memory_at_reply = reply.ua_memory;
    delete reply.ua_memory;
    result.reply = reply;
    result.at_reply = atReply;
    result.outputs_vs_replay = Object.fromEntries(Object.keys(reply.outputs ?? {}).map((file) => {
      const mine = readFileSync(join(out, "outputs", file));
      const theirs = readFileSync(join(synCall.cwd, file));
      return [file, { bytes_equal: sha256(mine) === sha256(theirs), decompressed_equal: sha256(gunzipSync(mine)) === sha256(gunzipSync(theirs)), uploaded_sha256_matches_page: sha256(mine) === reply.outputs[file].sha256 }];
    }));
    const gateFile = join(replay, "gate.json");
    result.replay_gate = existsSync(gateFile) ? JSON.parse(readFileSync(gateFile, "utf8")).gate : null;
    result.linear_memory = await observed(handle);
    result.renderer_after_run_kb = rendererRss();
    note({ reply: { error: reply.error, wall_s: reply.wall_s }, capacity: result.linear_memory.memories.map((m) => m.byteLength) });
    label = "terminated";
    await page.evaluate(() => self.workers.syn.terminate());
    const after = [];
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      sample(label);
      after.push({ t: now(), renderer_rss_kb: rendererRss() });
    }
    result.after_terminate = after;
  } else {
    sample("idle");
    const baseline = rendererRss();
    await startWorker("syn");
    label = "syn";
    note({ posted: "syn", baseline_renderer_rss_kb: baseline });
    await postSyn("syn");
    const posted = now();
    while (rendererRss() - baseline < 1024 * 1024 && now() - posted < 600) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      sample(label);
    }
    result.before_terminate = { after_s: now() - posted, renderer_rss_kb: rendererRss(), baseline_renderer_rss_kb: baseline };
    label = "terminated";
    const t = now();
    await page.evaluate(() => self.workers.syn.terminate());
    note({ terminated_after_s: t - posted });
    const after = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      sample(label);
      after.push({ t: now() - t, renderer_rss_kb: rendererRss() });
    }
    result.after_terminate = after;
    result.reply_after_terminate = await page.evaluate(() => Promise.race([self.replies.syn, new Promise((r) => setTimeout(() => r("no reply (terminated)"), 1000))]));
    label = "rigid";
    const handle = await startWorker("rigid");
    const rigid = await page.evaluate(async (argv) => {
      const inputs = {};
      for (const n of ["fixed.nii", "moving.nii"]) inputs[n] = new Uint8Array(await (await fetch(`/test/data/${n}`)).arrayBuffer());
      const reply = await new Promise((resolve) => {
        self.workers.rigid.onmessage = ({ data }) => resolve(data);
        self.workers.rigid.onerror = (event) => resolve({ error: `worker error: ${event.message}` });
        self.workers.rigid.postMessage({ id: 2, argv, inputs });
      });
      const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
      const mat = reply.outputs?.["out0GenericAffine.mat"];
      return { error: reply.error ?? null, sha256: mat ? hex(await crypto.subtle.digest("SHA-256", mat)) : null };
    }, [...ARGV]);
    result.rigid_after_terminate = { ...rigid, native_bytes: rigid.sha256 === NATIVE_MAT_SHA256, linear_memory: await observed(handle) };
    sample("rigid-done");
    result.renderer_after_rigid_kb = rendererRss();
    await page.evaluate(() => self.workers.rigid.terminate());
  }
  result.problems = browserResultProblems(result, NATIVE_MAT_SHA256);
  if (result.problems.length) throw new Error(result.problems.join("; "));
  succeeded = true;
} catch (error) {
  result.error = String(error);
  console.error(result.error);
} finally {
  clearInterval(sampler);
  sample("end");
  result.peaks = peaks;
  result.elapsed_s = now();
  writeFileSync(join(out, "result.json"), `${JSON.stringify(result, null, 1)}\n`);
  await browser?.close();
  server.close();
  setTimeout(() => {
    const left = processes();
    writeFileSync(join(out, "left-processes.json"), `${JSON.stringify(left)}\n`);
    if (left.length) {
      result.cleanup_error = "Chromium descendants remain after browser.close()";
      writeFileSync(join(out, "result.json"), `${JSON.stringify(result, null, 1)}\n`);
      console.error(result.cleanup_error);
    }
    process.exit(succeeded && left.length === 0 ? 0 : 1);
  }, 3000);
}
