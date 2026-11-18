# RFC draft: NiiVue MCP for desktop and hosted web apps

Status: Draft

Date: 2026-10-22

Implementation evidence: the proof of concept in
[PR #556](https://github.com/neurodesk/webapps/pull/556), branch
`feat/nv-mcp-bridge`, described under [Proof of concept](#proof-of-concept).

## Summary

Adopt [`@niivue/nv-mcp`](https://github.com/niivue/mono/tree/main/packages/nv-mcp)
as the agent vocabulary for NiiVue viewers in Neurodesk Webapps. The desktop MCP
server registers nv-mcp's core tools beside its own `apps_*`, `runs_*` and
`sessions_*` tools, and routes them to retained viewer windows through an
Electron bridge. Hosted web apps later reach the same tools through nv-mcp's
WebSocket client and a server the user runs locally.

Neither path adds a server outside the user's computer. The desktop serves MCP
over stdio, and a hosted page connects only to a server on `127.0.0.1`. The
agent the user connects receives what the tools return. That includes
screenshots, scene state and image statistics, and on the desktop also run
reports and output files. An agent that runs on a cloud model sends what it
receives to its provider. A hosted relay is described as a later option and is
not proposed for implementation here.

## Motivation

[PR #529](https://github.com/neurodesk/webapps/pull/529) added
`viewers_volumes`, `viewers_display` and `viewers_screenshot` to the desktop
MCP server. Those tools exist only in the desktop, over stdio. The web apps at
webapps.neurodesk.org have no agent path.

NiiVue upstream now publishes nv-mcp. It does the same job for any NiiVue page:
an agent connects over streamable HTTP, the page keeps a WebSocket open to the
same server, and each tool call is answered by the page from its live scene. Its
tool set is a superset of ours. Maintaining a second NiiVue vocabulary would
duplicate upstream work and give agents two names for one action.

## Existing boundary

The two protocols overlap on viewer control and are disjoint elsewhere.

| Desktop tool | nv-mcp tool |
| --- | --- |
| `viewers_state` | `where_am_i` |
| `viewers_crosshair` | `go_to_point` |
| `viewers_volumes` | `where_am_i`, `describe_volume` |
| `viewers_display` | `set_view`, `set_volume` |
| `viewers_screenshot` | `screenshot` |
| `viewers_regions` | `list_regions`, `go_to_region` through the page's `atlas` hook |
| `sessions_list` | `list_tabs`, `use_tab` |

nv-mcp has no equivalent for application runs: `apps_*`, `runs_*`, `run_<app>`,
DICOM series selection, provenance and the report and artifact resources. It has
no equivalent for `viewers_tab`, which selects an application's own UI tab.
These remain Neurodesk tools.

nv-mcp has roughly 40 tools we lack, including clip planes, camera, meshes,
drawing, measurements and agent-placed controls.

## Compatibility evidence

`@niivue/nv-mcp@1.0.0-rc.7` was installed from npm and its server half was
driven from Node 24 against `@modelcontextprotocol/server@2.1.0`, the version
the desktop uses:

- `registerCoreTools(server, toolContext(bridge))` registered 62 tools on a
  2.1 `McpServer`, all with object input schemas.
- A 2.1 client called `where_am_i` and `screenshot` through nv-mcp's `Bridge`
  to a simulated page. `screenshot` returned an MCP image block, the same
  shape as `viewers_screenshot`.
- The 2.1 server rejected an unknown argument to `go_to_point` because nv-mcp
  declares strict object schemas.
- `@niivue/nv-mcp/server` imports in Node. `Bun.serve` is referenced only
  inside `startServer`, which the desktop does not call.

nv-mcp's browser half is written against NiiVue's 1.0 API through a `View`
interface. Comparing that interface with the installed NiiVue typings, every
member absent from 1.0.0-rc.9, rc.11, rc.13, rc.14 and rc.26 is optional in
`View`. Eighteen catalog viewers use a 1.0 release candidate. `surfannotate`
uses 0.69 and keeps the existing adapter.

## Design

### Page

`createNiivueAdapter` gains a `niivue` member. On first use it imports
`automation/nv-mcp.js`, the only module that loads `@niivue/nv-mcp/browser`,
and builds `coreHandlers({ view: nv })` once. Apps pay for the code only when
an agent calls it, and an app without a NiiVue adapter does not bundle it. The
components list nv-mcp as an exact devDependency, so app builds bundle the
client, and a production install of the components does not include nv-mcp.
In such an install, a call to `niivue()` from Node fails because the module
is missing. The viewer registry adds one command, `viewers.niivue`, with
`{ viewerId, method, params }`. It returns `{ result, state }`, where `state`
is nv-mcp's `sceneState`. A request without `method` returns only the state.

`viewers.list` reports a `niivue` capability. The command is added to the
two desktop allowlists: the page dispatcher in `browser-automation.js` and the
session commands in `viewer-sessions.js`.

### Desktop

A bridge module owns one nv-mcp `Bridge`. When a viewer session is retained it
attaches a socket for that session, reads the scene state and sends nv-mcp's
`hello` with the session ID as the tab ID. Each request the bridge sends is
forwarded as `viewers.niivue` through the existing session queue, so the
desktop's serialization, 30 second timeout and session limit still apply. The
reply is fed back with `bridge.receive`. Closing a session detaches its socket.

`screenshot` is not answered by the page. It is routed to the existing
`viewers.screenshot` path, which composites the window with `capturePage`,
because these apps do not preserve the WebGL drawing buffer.

The MCP server calls `registerCoreTools` next to its own tools. The
`viewers_*` tools stay unchanged in this phase.

### Hosted web apps

The same page handlers answer nv-mcp's `AgentClient` over a WebSocket. The
user runs `neurodesk-mcp` from `packages/agent-server` and registers
`http://127.0.0.1:4242/mcp` with their agent. The page connects only after the
user chooses **Connect an agent**, says in its status bar whether it is
connected, and can disconnect.

- **Why a Node server.** nv-mcp's `startServer` runs only on Bun. The
  `neurodesk-mcp` command serves nv-mcp's `Bridge` and `buildServer` over
  `node:http` and `ws` with the same checks. `/mcp` is stateless and protected
  against DNS rebinding. `/app` accepts pages on loopback names and on
  `https://webapps.neurodesk.org`, and `--allow-origin` adds others. It listens
  on `127.0.0.1` only. A malformed request, an invalid frame or a reset socket
  ends only that connection. A refused socket is destroyed once its reply is
  sent, so a client that holds it half open cannot delay shutdown.
- **Why its own package.** People using the hosted apps should not need
  Electron, and the desktop already serves the same tools itself. The package
  is private until the RFC settles its name and how it is installed.
- **Opt-in.** While this is a preview, an app shows the control only when its
  address has `?agent`, or `?agent=<port>` for a server on another port.
  Brain Extraction is the only app wired so far.
- **Browsers.** Chrome asks the user to allow local network access the first
  time a page connects. In the first test, on macOS, Firefox connected without
  asking. Safari blocks the connection as mixed content and offers no prompt,
  so it is unsupported. Its users need the desktop app, Chrome or Firefox. The
  page cannot tell a denied prompt from a server that is not running, so the
  waiting message names both.
- **Privacy.** A connected agent receives the page's screenshots and scene
  details. An app that offers the control says so in its Privacy text, and
  says that an agent on a cloud model sends them to its provider.
- **Loading.** A hosted page has no approval step. `load_volume` and the other
  loading tools fetch whatever the page can read under CORS, as any script on
  the page could, and a local path never works. The server's instructions say
  so.

### Loading new sources

Each viewer window can read only what its run was given. That means the URLs
in the run's inputs and anything under them, the files the main process read
for the page, and directories mounted for a directory input. Browser
permission prompts are always denied. So `load_volume`, `add_overlay` and
`load_mesh` fail for any other URL, and a local path never works.

Each viewer window has its own Electron session and its own address on the
local server. The apps' service workers make most page requests, and Electron
does not say which window such a request came from, so only the session can
tell viewers apart. The session's request filter checks everything the viewer
asks for against that viewer's grants, and a refused request counts against
that viewer alone. The viewer's address serves the app and that viewer's
mounts. Bundle and model files are shared. The desktop answers the viewer's
https requests itself and fetches granted sources and compute origins in the
viewer's session, so a cookie that a host sets stays with that viewer.

The desktop adds an approval step, so a source can be granted while the
session is open:

1. **Request.** The bridge checks the URL or path of every loading call before
   forwarding it, and any relative address that leads into the local server's
   mounts. If the source is already granted to the window, the call
   proceeds unchanged. Otherwise the bridge asks for it. A
   `sessions_grant { sessionId, url | path }` tool makes the same request
   ahead of time, for agents that want to batch approvals.
2. **Consent.** The desktop shows a dialog attached to that viewer window. It
   names the agent's request, the file or URL, and the session's app, and
   offers **Allow** and **Deny**. The person at the viewer approves, not the
   agent client. MCP elicitation is not used, because client support varies
   and the client may not be the person viewing the data. If there is no
   answer before the session's 30 second command limit, the request is
   denied, and the tool error says so.
3. **Grant.**
   - **URL:** the URL is added to the viewer's source grants.
   - **Local path:** the file is resolved with `realpath` and served on its
     own through a one-time token at the viewer's address, as directory
     inputs are. The forwarded call's argument is rewritten to that URL.
4. **Lifetime.** A grant belongs to the session. It is revoked, and the
   viewer's address closed, when the session closes for any reason. Grants
   are never shared between windows. Another viewer's address is just another
   URL, and a relative address reaches only this viewer's own mounts. Grants
   are not remembered across sessions. A closed viewer's browser session is
   cleared, cookies and cache included, before another viewer reuses it. A
   session that fails to clear is not reused.

Denials and approvals are recorded in the session's run record, so a report
can show which sources an agent added after the run.

The hosted web apps have no approval step. As
[Hosted web apps](#hosted-web-apps) describes, the loading tools fetch only
what the page can read under CORS, and a local path never loads.

### Later options

A hosted relay on Cloudflare Workers with a Durable Object per pairing would
let cloud agents reach a tab. The relay would carry screenshots and region
readouts derived from patient data, so it needs a privacy decision before any
implementation. AWS Lambda and Google Cloud Functions do not hold long-lived
WebSockets without extra services and are not proposed.

### Browser-registered tools (WebMCP)

[WebMCP](https://webmachinelearning.github.io/webmcp/) (Draft Community Group
Report, 13 November 2026) lets a page register tools with an agent built into
the browser through `document.modelContext.registerTool`. It needs no server,
and no tool leaves the page until the agent calls it. Every app now registers
tools there, built from its automation contract, with no change to any app.

The app shell (`site/app-shell.js`) checks for `document.modelContext`, and
for `navigator.modelContext` from earlier drafts. If neither exists, it loads
nothing more. Otherwise it imports `webmcp/page.js` from the shell's copy of
the components. That module waits for the `neurodeskAutomation` global that
`registerAppAutomation` sets, reads the contract, builds the tool table with
`webMcpTools()` (`webmcp/tools.js`) and registers it with
`registerWebMcpTools()`. A tool the browser refuses is logged once and leaves
the rest registered. The automation barrel imports none of this, so the
command lines that import it reach neither `webmcp/` nor `ui/`.

The tools reuse the desktop's names and argument names where they mean the
same thing.

| Tool | What it does |
| --- | --- |
| `app_describe` | Returns the contract's operations, the examples that the page's example selectors offer, `unavailableExamples` with the reason each cannot be loaded, the viewers, the current run, the files each input role holds (`inputs`) and the files the person loaded into the page's own inputs (`pageFiles`). |
| `inputs_request_files { role, message? }` | Asks the person to choose files for a role in a shared dialog and holds them. Returns names and sizes, or `{ declined: true }`. A DICOM role also offers a folder. |
| `inputs_use_page_files { role, input }` | Holds the files of one `pageFiles` entry for a role, so an agent runs on what the person already opened. |
| `inputs_load_example { exampleId }` | Downloads an example through `fetchModel`, which checks its checksums, and holds its files by role. |
| `run_<operation>` | One per operation. Takes `parameters`, with a JSON Schema written from the contract, `selections` for DICOM roles, `inputs` for URL roles and `waitSeconds` (default 30, at most 600). Hands the held files to the app, starts the run and returns the run when it ends or when `waitSeconds` passes. The files stay held, so a rerun with other parameters asks for nothing. Aborting the call cancels the run. |
| `runs_get { runId?, waitSeconds? }` | Returns the current run and can wait for it to end. |
| `runs_cancel { runId? }` | Cancels the current run. |
| `outputs_download { artifactId }` | Saves an output of the last successful run, or `report`, to the person's downloads. |
| `user_ask { question, options?, allowText? }` | Asks the person a question in a shared dialog. Returns `{ answer }` or `{ dismissed: true }`. An agent uses it to resolve `SERIES_SELECTION_REQUIRED` from the candidates in the failed run. |
| `viewers_list`, `viewers_state`, `viewers_crosshair`, `viewers_tab`, `viewers_regions`, `viewers_volumes`, `viewers_display`, `viewers_niivue` | Send the matching `viewers.*` command. They are registered before any viewer exists, so the command's own error answers a call that comes too early. |

Tool results are JSON text. A tool reports a failure as `{ error: { message,
code?, candidates? } }` rather than rejecting, because the browser gives the
agent a rejection without its message. Pure reads carry `readOnlyHint`.
Results that hold file names, report text or answers typed by the person carry
`untrustedContentHint`. `outputs_download` carries `consequentialHint`.
`viewers_screenshot` is left out because results are text only and a browser
agent sees the page.

Held files live in `webmcp/inputs.js`. They are released when the app clears
its examination (`registerAppAutomation`'s `reset` fires
`neurodesk-automation-reset`) or when the person loads files into one of the
app's classified inputs while no run is going. A page input's files are
forgotten when it takes new ones. The tools therefore keep no file the app has
let go of.

An example's file roles serve the page's example selector and sometimes differ
from the contract's. The example's `automation` field in `examples.json` maps
them, leaves files out with a `reason`, or says why the example is
`unavailable` (`webmcp/examples.js`). `node scripts/webmcp-examples.mjs`
reports every app's examples.

WebMCP has no way to ask the person anything. `createAgentPrompts()` provides
the questions and file requests as `dialog.nd-dialog` dialogs. One shows at a
time and the others wait. Each says that an AI agent the person started is
asking. Closing a dialog declines it, and an aborted call closes it.

- **On by default.** The tools register wherever the browser exposes the API,
  with no `?agent` switch. The person starts the browser's agent, and the page
  sends nothing until it calls a tool. To gate the tools later, change the
  check in `site/app-shell.js`.
- **Browser support.** No browser enables WebMCP by default. Chrome for
  Testing 156 implements it behind `--enable-features=WebMCPTesting` (or
  `WebMCP`, or `--enable-experimental-web-platform-features`), with
  `getTools()` and `executeTool()`. Chrome also offers an origin trial. Each
  catalogue in `registry/apps.yml` has a `webmcp_origin_trial` token, empty
  for every host; the catalogue projection writes a token into that host's
  app pages only.
- **Privacy.** `shared.agents` in `registry/app-information.yml` closes every
  Privacy dialog, the app's own included: nothing reaches the agent until it
  calls a tool; it can read run reports with file names and checksums,
  measurements, viewer state and the answers typed into its dialogs; an agent
  in the cloud sends what it reads to its provider.
- **Tested.** Node tests build the table from every app's `automation.json`
  and check that each run schema accepts and refuses the same parameters as
  the contract; they also state the held-file lifetime.
  `pnpm --filter @neurodesk/agent-server validate:webmcp` runs a whole Brain
  Extraction analysis through Chrome's own WebMCP: example, run, viewer, both
  dialogs, the real file chooser, a rerun with another threshold, a file the
  person opened in the sidebar, and a download. `node test/webmcp.smoke.mjs`
  checks every app of the built site at 1440 and 390 px: the full tool set,
  `app_describe` with every loadable example, both dialogs, the Privacy
  statement, and that a browser without WebMCP loads none of its modules.
  On 18 November 2026 all 63 apps passed in 342 s; CI runs it in the
  composite-site job.
- **Full runs.** `WEBMCP_RUNS=1` also loads each app's first loadable example,
  runs it with the example's parameters and saves an output, through the tools
  only, with a 420 s limit per run (five catalogue shards in parallel on 16
  cores, SwiftShader WebGPU). On 18 November 2026, 43 apps completed: ants,
  ants-denoise, brain-extraction, brain2print, calcium-imaging, carotid-flow,
  dcm2niix, deconvolution, deface, degibbs, dicompare, dicomview,
  disconnectome, dwicorrect, dwidenoise, edgereg, elastix, greedy, histo2mri,
  lcmodel, lightsheet-atlas, me-ica, microscope-qc, mri2vid, n4, nesvor (its
  viewer operation), neuromorph, niimath, noddi, omezarr-convert,
  pipeline-builder, qsmbly, reproin, samsrf, sdc, spinalcordtoolbox,
  spot-detection, stardist, stitching, structure-tensor, surfannotate, synthsr
  and topofit. Ten ran past the limit: bison, brainqcnet, calmar, fastprep,
  fireants, gliomoda, hmc, musclemap, vesselboost and white-matter-lesions.
  Five failed for the GPU or the browser, not the tools: brainchop (WebGL
  texture limit), browserqc (niimath timed out under load), dwi2trx (needs
  32-lane subgroups), syncro and synthseg (GPU memory). Two need parameters
  their examples do not state: easy-mp2rage (the nine MP2RAGE acquisition
  values) and microsam (point or box prompts). cryo-em, seedseg and zarro have
  no example the tools can load.
- **Untested.** No browser agent has called these tools: every call came from
  a test through `executeTool`.

## Phases

1. Desktop proof of concept: nv-mcp core tools over retained sessions.
2. Approved source loading on the desktop: consent dialog, appended grants,
   and single-file mounts.
3. Hosted page client behind an opt-in control, with a documented local server.
4. Alias then deprecate the overlapping `viewers_*` tools.
5. Decide on a hosted relay separately.

## Open questions

- **Viewer identity.** nv-mcp addresses a tab. Some apps register more than
  one viewer per page. The proof of concept drives the `main` viewer, or the
  first NiiVue viewer. Upstream could accept a viewer argument instead.
- **Approval scope.** [Loading new sources](#loading-new-sources) asks once
  per file or URL. Decide whether **Allow** may also cover a directory or a
  URL prefix for the rest of the session, and whether an unattended run, such
  as a desktop job or CI, may pre-approve sources through a configuration
  setting. The proof of concept pre-approves through
  `NEURODESK_APPROVED_SOURCES` and can refuse instead of asking through
  `NEURODESK_SOURCE_APPROVAL=deny`. The **Allow** scope is still open.
- **Duplicate MCP SDK.** nv-mcp depends on `@modelcontextprotocol/sdk` 1.x.
  Only the processes that serve tools need it: the desktop, which installs it
  beside 2.1, and `neurodesk-mcp`. Both list nv-mcp as a dependency. Pages use
  only nv-mcp's browser entry, which the components list as an exact
  devDependency for app builds to bundle. `pnpm deploy --prod` therefore leaves
  nv-mcp, the SDK and its server dependencies out of the command-line archives
  built from the components. Ask upstream to make the SDK a peer dependency or
  move to 2.x.
- **Prerelease pin.** The proof of concept pins `1.0.0-rc.7`, the release it
  was tested against. To adopt a later release candidate, change four pins
  together: the components' devDependency, the desktop's and
  `@neurodesk/agent-server`'s dependencies, and the `nv-mcp` family's version,
  target and sha256 in `runtime-assets/manifest.json`.
  `test/nv-mcp-dependencies.test.mjs` fails when the versions differ, and the
  composite build fails when the bundled chunk's sha256 differs from the
  family's.
- **Local network access.** Tested with Playwright on macOS, a page on
  `https://webapps.neurodesk.org` opening `ws://127.0.0.1`:
  - Chromium 156 and Chrome 155 fail with
    `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` until the
    `local-network-access` permission is granted, which a person does at the
    prompt. The server then sees the page's own origin. Headed Chrome 155
    reports the permission as `prompt` and holds the socket open until the
    person decides, where headless fails at once.
  - Firefox 157 connected without a prompt. Later runs on Linux could not
    repeat the check, because headless Firefox there has no WebGL2 and the
    page never gets a viewer.
  - WebKit 27.2 blocks the socket as mixed content, with no permission to grant.

  nv-mcp's README says an HTTPS page cannot open `ws://127.0.0.1` at all,
  which is out of date for Chrome and Firefox. Still open: whether Chrome's
  prompt wording is clear enough, and whether a later Safari adds a prompt.
- **Atlas regions.** Apps expose regions through `viewers_regions` today.
  Mapping them onto nv-mcp's `atlas` hook needs an adapter per app.
- **Local files in hosted apps.** A hosted page cannot read a local path. An
  in-page prompt with a file picker could let the person hand the page the
  file an agent asked for. It is not implemented.

## Proof of concept

Phase 1 runs on branch `feat/nv-mcp-bridge` against `@niivue/nv-mcp`
`1.0.0-rc.7`.

- **Real viewer.** `scripts/desktop/automation-smoke.mjs` runs BET in
  brain-extraction (NiiVue `1.0.0-rc.26`) under Electron on macOS and retains
  the viewer. Then it uses only nv-mcp tools:
  - `list_tabs` lists the session as a bound tab titled `brain-extraction`,
    with the scene state.
  - `go_to_point` moves to `[-18, -40, 6]`, and `where_am_i` reports
    `[-18, -40, 6.000002]`.
  - `set_view { slice: "coronal" }` changes the view, and `screenshot`
    returns a 2240×1508 PNG that differs from the earlier axial capture.

  The existing `viewers_*` checks pass unchanged in the same run. The smoke
  also passes on Linux under xvfb.
- **Tests.**
  - Desktop: an MCP stdio test drives `list_tabs`, `go_to_point` and
    `screenshot` through a fake session. It checks that strict schemas reject
    unknown arguments, that a page error returns a tool error, and that a
    closed session leaves `list_tabs`.
  - Components: a test drives `viewers.niivue` against a fake NiiVue: state
    only, `set_view`, an unknown method, invalid parameters, and a 0.x viewer.
- **Bundle cost.** Vite emits nv-mcp's browser handlers and `AgentClient` as
  one lazy chunk, `nv-mcp-<hash>.js`. At rc.7 it is 104,301 bytes, about 32 KB
  gzipped, and every Vite app with a NiiVue adapter emits the same bytes. The
  composite site serves it once, from `_runtime/nv-mcp/1.0.0-rc.7/nv-mcp.js`,
  which `runtime-assets/manifest.json` pins by sha256 as the `nv-mcp` family.
  An app without a NiiVue adapter ships none. Import-map apps that call
  `createNiivueAdapter` get `automation/nv-mcp.js` bundled with its client
  in their standalone builds, and import the shared file in the composite
  site. The chunk loads only on the first `viewers.niivue` call, or when a
  person chooses **Connect an agent**. Brain Extraction's main chunk grows by
  about 3 KB.
- **Dependencies.**
  - The exact pin needs a `minimumReleaseAgeExclude` entry, because rc.7 was
    one day old when it was adopted. This matches the existing `@niivue`
    prerelease entries.
  - nv-mcp's `@modelcontextprotocol/sdk` 1.x brings express, hono, cors, jose
    and their dependencies into the lockfile. The desktop and
    `neurodesk-mcp` depend on nv-mcp and ship them, because they serve the
    tools. No page loads them.
  - The components list nv-mcp only as a devDependency. `pnpm deploy --prod`
    leaves nv-mcp, its server dependencies and the NiiVue release that pnpm
    installs as nv-mcp's peer out of every command-line archive.
    `test/nv-mcp-dependencies.test.mjs` walks each release target's
    production dependencies in the lockfile and fails if MCP code is among
    them. Making the SDK a peer dependency upstream would remove the stack
    from the lockfile.
- **Source approval.** Phase 2 is in the same branch.
  - The bridge finds every loading address in a call: each `url`, a `labels`
    table, and `set_font`'s `atlas` and `metrics`. An absolute path, a `file:`
    URL or an http(s) URL outside the window's grants is approved first,
    then rewritten to the granted address. Relative URLs pass through.
    Before any of them is approved, every address the page would fetch (each
    `url`, a `labels` table, `set_font`'s `atlas` and `metrics`) is read as
    the page would read it, and the call is refused if one carries a user
    name or password, however it is written.
  - Approval comes from `NEURODESK_APPROVED_SOURCES`, a comma-separated list
    of absolute directories and http(s) URL prefixes, or from an
    **Allow**/**Deny** dialog on the viewer window. The dialog waits 30 s and
    then denies. `NEURODESK_SOURCE_APPROVAL=deny` refuses at once instead of
    asking.
  - An approved URL is appended to the window's grants. An approved file is
    served alone through a token URL on the local server, which checks that
    its real path has not changed. Both end with the session.
  - The smoke pre-approves its runs directory and sets `deny`. `add_overlay`
    of the run's BET mask by path adds a volume. `add_overlay` of the input
    fixture by path fails with the deny error and adds nothing. An earlier
    run with the dialog loaded the fixture after a person clicked **Allow**.
    **Deny** and the timeout were not tried by hand.
  - `sessions_grant { sessionId, path | url }` approves a source ahead of
    time and returns its `grantedUrl` and how it was approved: by a `person`,
    by `configured` pre-approval, or `existing`.
  - Each new approval and each refusal is appended to `sources` in the run
    record (`run.json` and `runs_get`), and stays after the session closes.
    Sources the session could already load are not recorded.
  - The smoke checks that a second `sessions_grant` of the mask returns
    `existing`, and that refusing the fixture by `sessions_grant` fails. It
    also checks that `run.json` lists the mask approval and both refusals.
  - Each run's window gets its own session, from a pool of in-memory
    partitions that are cleared and reused, and its own local server. An
    earlier version told windows apart by `webContentsId`, which Electron
    leaves empty for service worker requests. Approved URLs then failed in
    Brain Extraction, any window could load another's token URL, and one
    viewer's refused request failed the run in progress.
  - The https handler fetches approved sources and compute traffic with the
    viewer's session, not with `net.fetch`'s default session. With
    `net.fetch`, a cookie that a host set for one viewer reached other
    viewers and the profile on disk.
  - Closing a viewer clears its storage and its cache. The desktop waits for
    both clears to settle before it quits, even when one fails, because a
    clear that finishes after Electron's shutdown crashes the process.
  - The smoke loads two approved remote images on a loopback IP address, one
    granted by `sessions_grant` and one by `add_overlay`, and refuses a URL
    with credentials. A second viewer cannot load the first's mask by its
    token URL or by `../_local/…`, and its `run.json` lists both refusals. A
    run succeeds while a retained viewer's redirect out of its grants is
    refused, and closing the first viewer stops its address.
  - Over https, the smoke checks that a cookie that an approved host or a
    compute origin sets goes back only to the viewer that received it. The
    second viewer, the next viewer on the first one's cleared session, and a
    relaunched desktop send none, and no profile file holds it.
- **Timeouts.** The bridge timeout is 65 s: a 30 s approval wait plus the
  session's 30 s command limit. A stalled page is reported by the session,
  which also closes it, before nv-mcp's own timer fires.
- **Screenshot.** The desktop answers nv-mcp's `screenshot` with a window
  capture, so its size and format arguments are ignored. Honouring them means
  scaling the capture in the main process.
- **Session lifecycle.** The automation service now publishes `ready` and
  `closed` session events. The bridge attaches a tab only once a run has
  succeeded, and detaches it when the session closes for any reason: a
  `sessions_close` call, a command timeout, the window closing, or shutdown.
- **Hosted page.** Phase 3 is in the same branch.
  - `packages/agent-server` tests drive a fake page through `/mcp` with the
    MCP SDK client. They check that a page on another origin is refused with
    403, and that `/` and `/mcp` refuse a foreign `Host`. They also check that
    a malformed request or frame, a client that resets a refused socket, and
    a client that holds a refused socket half open neither stop the server
    nor delay its shutdown.
  - `packages/agent-server/validation/browser-smoke.mjs` serves the built
    Brain Extraction app at its hosted address in each Playwright browser,
    opens an image, and clicks **Connect an agent**. An MCP client then calls
    `list_tabs`, `set_view`, `go_to_point` and `screenshot`. Chromium 156,
    with the permission granted, passes, and its screenshot shows the axial
    slice. Firefox 157 passed in the first run, on macOS. On Linux, headless
    Firefox has no WebGL2, so the page never gets a viewer. WebKit 27.2 stays
    waiting, as expected.
  - nv-mcp's own servers default to port 4242 too, so a NiiVue page's dev
    server can hold it. `neurodesk-mcp --port` and `?agent=<port>` move both
    ends.
  - Brain Extraction's Privacy text says what a connected agent can read and
    that an agent on a cloud model sends it to its provider.
