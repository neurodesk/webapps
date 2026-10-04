# Agentic webapp testing

TesterArmy's `e2e` runner supplements the existing Playwright and scientific parity suites. `test/agentic/catalog.e2e.ts` derives its coverage from `registry/apps.yml` and each app's `examples.json`, so registering an app automatically includes it. Tests run against production output on desktop and a 390-pixel phone viewport. Phone coverage here checks the narrow layout; the existing mobile suite checks touch behavior.

The model is the stable `neurodesk` alias at `https://llm.neurodesk.org/openai`, through the OpenAI-compatible chat completions API. This matches [Neurodesktop's provider configuration](https://github.com/neurodesk/neurodesktop/blob/main/docs/environment-variables.md). Set `NEURODESK_API_KEY` in the environment for local agent runs and in the repository's Actions secrets for scheduled or manually dispatched runs. Credentials remain outside source control. The alias currently resolves to a text-only model. The engine sends semantic UI observations, not screenshots, to the service. Screenshots remain local failure evidence. Use public, de-identified fixtures. Structured responses are enabled, model output is capped at 8192 tokens, and judgments have a two-minute deadline.

## Run the suite

Install dependencies with `pnpm install`, then install Chromium with `pnpm exec playwright install --with-deps chromium`.

```sh
# Build and check every app without a model call.
pnpm test:e2e:catalog

# Inspect coverage without building, launching browsers, or calling the model.
pnpm test:e2e:agent --list
pnpm test:e2e:pipeline --list

# Build one app and exercise agent-driven help and example import.
pnpm test:e2e:agent --app niimath --target desktop

# Process its example and verify a nonempty scientific download.
pnpm test:e2e:pipeline --app niimath --target desktop --no-cache

# Reuse a fresh composite production build.
pnpm test:e2e:catalog --skip-build --output .e2e/workspace
```

`--app` accepts comma-separated catalog ids. `--grep` narrows test titles and `--output` keeps evidence from different runs separate. `--site-dir` selects an existing production site directory, and `E2E_BASE_URL` selects an already running site. The managed server binds only to loopback and serves the same isolation headers as the existing browser checks. Scratch profiles and staging directories use `TMPDIR`. `E2E_HEADED=1` shows Chromium locally; `E2E_CHROMIUM_EXECUTABLE` optionally selects an installed Chromium binary. On a Linux machine with a hardware GPU, set `E2E_SOFTWARE_GPU=0` to disable the default SwiftShader launch flags. Every test gets its own browser process, including after a failure.

## What passing means

- `workspace` verifies one shared application bar, the status footer, the published automation contract, and the exact example inventory. It needs no model credentials.
- `agent` asks the model to open and close About and Cite and select each pinned example. Exact assertions check the open dialog, closed dialog, loaded example id, and completed import. The example selector resets its value after import so the same example can be selected again; the loaded id remains on the element's `data-example-id`.
- `pipeline` asks the model to advance the first example's workflow one processing stage at a time. The runner waits up to 30 minutes for each stage using the native progress bar, then asks for the next action or completed outputs. This keeps long inference out of the model's waiting loop. It permits eight stages within a two-hour test deadline, then asks for a scientific download. Assertions check a nonempty download, a scientific file extension, and no failed run state. NiiMath additionally runs exact arithmetic and verifies that every downloaded voxel equals seven with the expected dimensions. Existing app-specific tests remain responsible for other numerical accuracy, provenance, and exact output semantics.

Zarro's viewer workflow changes zoom or slice and exports the current field of view; its NIfTI must contain three planes with nonzero, varying values. SurfAnnotate supplies four real cortical pointer clicks because the model cannot visually place a border. The agent closes, fills, names and exports the ROI; the downloaded FreeSurfer label must contain the declared positive number of vertices. VesselBoost deterministically skips its three optional preparation stages before agent-driven segmentation. DWI2TRX's indeterminate progress returns to zero between stages; its workflow waits for that transition and requires a TRX download.

CALMaR reports 100% at intermediate worker stages. Its processing wait therefore ends only at mask review or final completion. The agent confirms the generated public-example mask, resumes mapping, and must reach final completion before downloading. SYNcro selects CPU · WebAssembly on Linux when the software GPU flags are enabled, because its example exceeds SwiftShader's buffer limit; hardware runs retain WebGPU. Its full-volume CPU executor keeps activation storage in 64 MiB chunks without changing operator slabs or channel ordering. Full inference remains resource intensive on either backend.

SeedSeg has no public prostate example, so its workspace and help are covered and its pipeline is explicitly skipped until a suitable fixture is available. Dicompare uses Print for its report; its agent workflow verifies the reference and test acquisition panels and opens the populated print options. It does not claim to verify the browser's print dialog or a PDF download. NeSVoR connects to the existing loopback reference compute server and tests submission and download of its simulated response. This explicitly named integration test does not validate browser inference or CUDA processing. Its CPU reference mode requires reviewed masks absent from the public example. WebGPU-heavy pipelines need a suitable adapter; the Linux software adapter used for startup tests does not establish hardware numerical parity.

## CI and evidence

The composite-site job runs workspace checks for every app after the production build. Scheduled and manually dispatched CI also run agent help and example import if the Neurodesk secret is configured; a missing secret produces an explicit notice. Pull requests do not receive the model key. Manual dispatch offers `agentic_mode=pipeline` and an optional `agentic_apps` filter. Processing runs use desktop and disable the replay cache. They are explicit because they can download large models and take substantially longer.

The runner writes `report.json`, `junit.xml`, failure traces, and download artifacts under `--output`, defaulting to `.e2e`. CI uses separate workspace and agent output directories and uploads them even on failure. Local verified agent steps use the framework's replay cache; `--no-cache` exercises the live model. CI's default cache is read-only. Telemetry is disabled by the wrapper. The Neurodesk key is registered with the runner's secret redaction system as well as supplied to the provider.

The framework and web engine are pinned because their APIs are pre-1.0. Playwright and `@playwright/test` share version 1.63.0 across the workspace: mixing the new CLI with older test imports prevents test discovery. `test/playwright-discovery.test.mjs` checks the existing suites that exposed this mismatch. `test/agentic-provider.test.mjs` verifies that screenshot content is removed at the provider boundary while semantic text and tool results are preserved. Update the framework and engine together, run `pnpm test:e2e:types`, inspect `--list` for all catalog entries, and exercise a production app with the real provider. An agent failure should retain its assertions and evidence; changing a locator must not remove scientific checks.
