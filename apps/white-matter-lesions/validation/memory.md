# Browser ensemble memory

Both callers used to hold five graph buffers, each 61,642,305 bytes, throughout inference. The shared pipeline already released sessions sequentially and accumulated weighted logit differences in one running sum. It now requests each verified graph after the previous session finishes releasing. This removes four extra application-held graph buffers, 246,569,220 bytes. It does not establish a corresponding decrease in peak resident memory: ONNX Runtime's working buffers, browser allocation and garbage collection also contribute.

## Reproduce

Build the production app, then measure its real five-fold CPU workflow:

```sh
pnpm --filter white-matter-lesions build
node apps/white-matter-lesions/validation/browser-memory.mjs \
  --browser chrome --output "$TMPDIR/flames-memory/chrome.json"
```

Set `CHROME_EXECUTABLE` to a Chrome for Testing executable to use full Chrome. Otherwise the pinned Playwright Chromium build is used. The harness verifies the published model pins and MSLesSeg example before serving them over loopback. It uses a fresh browser profile and the production app's automation interface. An instrumentation prefix caps the app worker's hardware concurrency at four and maps pinned URLs to the verified local files. It leaves the model files, production inference code and ONNX Runtime options unchanged.

For **native Safari on macOS**, enable WebDriver and select Safari:

```sh
sudo safaridriver --enable
node apps/white-matter-lesions/validation/browser-memory.mjs \
  --browser safari --output "$TMPDIR/flames-memory/safari.json"
```

See [Apple's WebDriver setup](https://developer.apple.com/documentation/safari-developer-tools/macos-enabling-webdriver). Safari runs through its native W3C WebDriver endpoint; Playwright WebKit is not used. The `white-matter-lesions-native` workflow requires both Chrome/Linux and Safari/macOS 15 runs and uploads their receipts and output volumes.

## What the receipt measures

The primary metric is the sum of **resident process RSS**, sampled once a second. Chrome includes the browser process and its descendants. On an isolated macOS runner, Safari includes Safari and WebKit WebContent/GPU/Networking services; unrelated WebKit services could affect that group. Every sample lists the processes counted. Sums can count shared pages more than once. This is an OS process metric, not an exact per-tab heap measurement, and excludes the Node asset server and validation process. Virtual address space and reserved WASM capacity are not used.

The idle baseline is taken after adopting the input file, before starting the operation and displaying the input. Sampling covers input import, SynthStrip, all five folds and result creation. It stops before FileReader/base64 allocations used to validate the downloaded output bytes. The receipt requires the final patch count, five model pins, CPU backend and the existing browser-reference gates. Errors fail the job.

The harness records `performance.measureUserAgentSpecificMemory` availability and, where available, requests a separate observation after completion. That API counts different objects and can trigger garbage collection. Its post-completion observation is outside RSS sampling, after the processing worker has been terminated, and cannot represent the inference peak. It is not combined with or compared directly to RSS. [WebKit's memory timeline](https://webkit.org/web-inspector/timelines-tab/) is another page-oriented diagnostic, distinct from these OS process readings.

Each receipt describes one completed run. Its baseline and sampled peak are ballparks for that browser, OS, runtime, backend, thread count and example, not a guaranteed memory requirement or a generalized improvement. There is no CPU-time comparison; elapsed time can be affected by competing workloads. Repeated, interleaved before/after runs would be needed to claim a peak-memory or timing improvement.

The app's shared About data advises allowing several gigabytes for the ensemble and using the default single fold on memory-limited devices. Sequential graph loading does not remove the large inference working buffers.

## Local receipt, 10 October 2026

One full Chrome for Testing **156.0.8078.4** run on Linux **7.0.0-29-generic**, ONNX Runtime Web **1.29.0**, WASM CPU, **four threads**, completed SynthStrip and **40 patches across five folds**. The fresh browser profile used verified local assets. The sampled browser-and-helper RSS baseline was **1,086,963,712 bytes, about 1.01 GiB**, and the observed peak was **5,003,423,744 bytes, about 4.66 GiB**. All seven existing browser-reference gates passed, with exactly the recorded summaries: **77 lesions, 11,841 mask voxels, 29.55 ml mask volume and 30.32 ml probability volume**. There were no errors. Elapsed time was 1,062 seconds; competing host workloads prevent a timing comparison.

This local run preceded the harness's addition of the separate UA-specific observation. A separate fresh idle production-page probe in the same Chrome version confirmed API availability and reported **9,484,604 bytes**. That observation had no imported image or inference and is neither the five-fold peak nor directly comparable to the RSS baseline. The mandatory CI harness now records the API observation after completion. Native Safari results require its macOS CI receipt; Linux Playwright WebKit does not provide Safari evidence.

The native ONNX Runtime 1.29.0 CPU path also completed all five folds with four threads. Against these actual Chrome outputs, mask Dice was **0.9993662** (existing minimum **0.998**) and maximum absolute probability difference was **0.01703313** (existing maximum **0.1**). Both NIfTI headers were identical; the native table matched its mask, and all seven native summary/reference gates passed. These retain the existing cross-runtime tolerances.

A second sequential native run used the previously published **flames 0.1.20261004 linux-x64** archive. All 651 archive files matched its manifest; its model manifest was identical to the current source, with ONNX Runtime 1.29.0 and four threads. Its complete five-fold mask, probability map and lesion table were **byte-identical** to the current native outputs. This checks output preservation across the loading change, not browser memory performance.
