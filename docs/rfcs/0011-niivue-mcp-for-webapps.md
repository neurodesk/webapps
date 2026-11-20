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
| `app_describe` | Returns the contract's operations, the examples that the page's example selectors offer with the run tool and parameters each needs, `unavailableExamples` with the reason each cannot be loaded, the viewers, the current run, the files each input role holds (`inputs`), the files the page's inputs, drops and handoffs received (`pageFiles`), whether the page may hold inputs the tools cannot list (`pageMayHoldOtherInputs`) and the example the person loaded in the page (`pageExample`), and whether the person has touched the examination (`touched`). A run the tools did not start in this examination is reported as `stale`, and this examination's run as `touched` while the person has not let the agent continue, both without the report. |
| `inputs_request_files { role, message? }` | Asks the person to choose files for a role in a shared dialog and holds them. Returns names and sizes, or `{ declined: true }`. A DICOM role also offers a folder. |
| `inputs_use_page_files { role, input }` | Holds the files of one `pageFiles` entry for a role, so an agent runs on what the person already opened. The person always sees the files in a shared dialog and confirms them first; refusing returns `{ declined: true }`. |
| `inputs_load_example { exampleId }` | Downloads an example through `fetchModel`, which checks its checksums, and holds its files by role in place of everything held before. |
| `run_<operation>` | One per operation. Takes `parameters`, with a JSON Schema written from the contract (a `required: true` parameter is required), `selections` for DICOM roles, `inputs` for URL roles and `waitSeconds` (default 30, at most 600). Refuses with `RUN_ACTIVE` while another run is going. Asks the person before it lets the app fetch a URL input, naming the address the app reads under (computed by the app's own `sourceRoots` function through the automation's `sources` command) and its origin. Hands the held files to the app, starts the run and returns the run when it ends or when `waitSeconds` passes. The files stay held, so a rerun with other parameters asks for nothing. On a touched examination it first asks to resume. Aborting the call cancels the run; the person using the page does not. |
| `runs_get { runId?, waitSeconds? }` | Returns the named run, or the current one, and can wait for it to end. A run another run replaced returns `RUN_REPLACED`, never the other run; a run from an earlier examination returns `RUN_STALE`. A run that has ended is returned as the tools recorded it when it ended. On a touched examination it first asks to resume. |
| `runs_cancel { runId? }` | Cancels the named or current run. The automation checks the run ID as it cancels, so a cancel never reaches a run that replaced the named one. On a touched examination it first asks to resume. |
| `outputs_download { runId, artifactId }` | Saves an output of the named run, or `report`, to the person's downloads, if that run is still the current one, belongs to this examination and still holds the output with the checksum recorded when it ended (else `RUN_STALE`). On a touched examination it first asks to resume. |
| `user_ask { question, options?, allowText? }` | Asks the person a question in a shared dialog. Returns `{ answer }` or `{ dismissed: true }`. An agent uses it to resolve `SERIES_SELECTION_REQUIRED` from the candidates in the failed run. |
| `viewers_list`, `viewers_state`, `viewers_crosshair`, `viewers_tab`, `viewers_regions`, `viewers_volumes`, `viewers_display`, `viewers_niivue` | Send the matching `viewers.*` command. They are registered before any viewer exists, so the command's own error answers a call that comes too early. `viewers_niivue` offers only the nv-mcp methods described below. |

Tool results are JSON text. A tool reports a failure as `{ error: { message,
code?, ... } }` rather than rejecting, because the browser gives the agent a
rejection without its message. The codes, listed once in `webmcp/tools.js`:

| Code | Meaning |
| --- | --- |
| `INVALID_INPUT` | The input does not match the tool's published schema; nothing ran. |
| `EXAMINATION_CHANGED` | The person used the page while the call was going: its result is withheld and nothing more was done. The next call that needs the held files or the run asks to resume. |
| `RUN_STALE` | The run belongs to an examination that had ended before the call began, or the page no longer holds the output the run ended with. |
| `RUN_REPLACED` | Another run, or a reset of the page, replaced the run; its outputs are gone. |
| `UNKNOWN_RUN` | The tools did not start this run. |
| `RUN_ACTIVE` | A run is still going. |
| `ADDRESS_REFUSED`, `REDIRECT_REFUSED`, `FETCH_FAILED` | An approved fetch that could not be made. |

A person refusing a dialog is not an error: the result is `{ declined: true }`. The browser does not check arguments against
`inputSchema`, so every tool checks its input against the schema it publishes
first (`webmcp/schema.js`) and returns `INVALID_INPUT` without running. Pure
reads carry `readOnlyHint`. Every result carries `untrustedContentHint` except
those of `inputs_load_example`, `outputs_download` and `viewers_list`, which
hold only what the app's author or the agent wrote. `outputs_download`,
`viewers_niivue` and run tools with URL inputs carry `consequentialHint`.
`viewers_screenshot` is left out because results are text only and a browser
agent sees the page.

`viewers_niivue` offers only the nv-mcp methods that
`webmcp/niivue-methods.js` classifies as reading the scene, changing the
display, or loading one file. Methods that export pixels or files
(`screenshot`, `save`), edit or remove data (`set_slide` and `set_signal`
among them), load a payload that can name further addresses
(`load_document`), read a file's format from its address (`load_signal`),
add page controls or take settings that can name an address are not offered.
Each offered method takes only the parameters `NIIVUE_PARAMETERS` lists, and
any other is refused: `set_volume` leaves out `affine`, `reset_affine`,
`transform`, `load_all_frames` and `v1`, which turns a vector volume into a
one-frame colour image for good, `load_mesh` leaves out `replace`, which removes
the meshes already loaded, and no method takes `tab`. Every taken parameter
was audited as reading the scene, changing only the display, or naming the
file the person approves, and the components test records that effect for each
one. `load_volume` replaces the volumes the viewer shows, so its consent says
so. A test holds the
table to nv-mcp's method list, so a method nv-mcp adds stays out until
someone classifies it; holds each method's allowed and refused parameters to
nv-mcp's own schemas (`CORE_SCHEMAS`), so a parameter nv-mcp adds stays out
until someone classifies it; and holds an audit of every offered method
against the pinned nv-mcp version, so a version bump fails until the audit is
redone. Before a call that names an
address (any `url`, or a label table address) and before a run with URL
inputs, the shared prompt asks the person, naming the app, each resolved
address and the server that sees the request. Declining returns
`{ declined: true, addresses }` and nothing is fetched. The tool does not
predict what NiiVue would fetch: it fetches each approved address itself,
without cookies, refuses a redirect (`REDIRECT_REFUSED`), and passes NiiVue a
`blob:` URL of the bytes with the file name, so NiiVue never receives an
address the agent wrote. A run with URL inputs is different: ZARRo reads a
store's metadata and chunks itself, so its prompt names the store root that
ZARRo's own normaliser computes from the address (an agent that names
`.../store.ome.zarr/.zattrs` is asked about `.../store.ome.zarr`) and says
that the app reads the addresses under it. The consent alone does not keep
the reads there, so ZARRo enforces it where it fetches (`src/confined_store.js`):
for a store an agent opened, a read outside the approved root is refused
before it is sent, and a redirect is refused instead of followed. Stores the
person opens are not confined. The desktop agent server and the nv-mcp
WebSocket keep nv-mcp's full vocabulary.

An examination (`webmcp/tool-inputs.js`) holds the files the agent holds and
the runs it started. Five reviews found that the tools cannot tell from page
events what the person did: a drop the shell took on a canvas, an Undo, an
app's own Remove button, a run the person started and a redisplay all looked
alike or reached no listener. The guarantee therefore rests on one event fact
only, whether the person did anything trusted in the page since the agent last
had their Allow, and on what the tools recorded, not on what the page answers.

- **Seeing the person first.** `site/theme.js` is the first script of every
  app page: the build puts it before any other script element, after the
  page's metadata and origin trial token, and `test/catalog-sites.test.mjs`
  fails on a built app page whose first script is another. When the browser exposes a model
  context, it adds capture listeners on window for every press, key, input,
  change, paste, wheel, `dragenter`, `dragover` and drop, and hands each event
  to the tools. A capture listener on window that is added first runs before
  every other listener, so no listener of the page or the shell can stop an
  event before the tools see it. Composed events from inside shadow roots pass
  window too. Same-origin frames, found at any depth and inside open shadow
  roots, get the same listeners on their windows from the first animation
  frame after each new document appears, and a frame navigating away from a
  document it showed touches the examination itself. A frame whose document
  the page cannot reach (another origin's) is followed on every animation
  frame while it is attached, so a document of the page's origin that
  replaces it is watched from its first frame too, and that change also
  touches the examination.
- **Touch.** A trusted action in the workspace touches the examination. The
  held files and the latest run stay, but the agent gets nothing from them
  without the shared resume dialog: `app_describe` reports `touched` without
  the report, and the next run, `runs_get`, `runs_cancel` or
  `outputs_download` asks first. Calls waiting on one touch share one dialog
  and its one answer. The dialog names exactly what Allow hands back: the
  latest run, by operation and start time, with what it was given (the files
  of the roles its operation reads, and for each url input the root the
  person allowed), and apart from them the files the agent keeps for its next
  run. It reads them when it shows, not when it was queued, and Allow applies
  only while they are still what it named: when the agent's own file request
  or example changed the held files meanwhile, the dialog shows the change and
  asks again. Loading the same example again changes nothing it names. It says the
  agent gets the results that run ended with, even if the page shows others
  now. Allow discloses that run and those files and clears the touch until the
  next one; the examination's earlier runs stay withheld (`RUN_STALE`).
  Decline ends the examination.
- **Truth at disclosure.** When a run the tools started ends, the tools record
  its input files and the snapshot it ended with: its report and the identity
  of each output (file name, size and SHA-256, as the report gives them).
  After Allow, `runs_get` returns that record, never what the page answers
  later. `outputs_download` takes a fresh snapshot of the run and saves only
  while it still holds the recorded output, and the automation checks the
  recorded checksum again as it saves; otherwise the call returns `RUN_STALE`
  and says the page holds other results. Every app registers through
  `registerAppAutomation`, which keeps each run's own output files and their
  checksums, so every app can establish this identity and none has to refuse
  a download after a touch. A run the person starts through the app's own
  controls never reaches the automation, so it cannot make the agent's run
  stale; the dialog's wording covers it instead.
- **End.** A convenience that spares the person a dialog with no point: a pick
  in any file input, files dropped on the page, the page's example selector
  starting a load, a handoff and the app's `automation.reset()`, and on a
  touched examination a list change the app reports with `nd-files` or files
  the page itself puts on a classified input (the shell's Undo). The tools
  change no app's list reporting: the shell's Undo restores what `nd-files`
  and `change` told it, so a report added for the tools changes what Undo
  puts back. A removal an app does not report is a press, which touches the
  examination. A new
  examination holds no files and the runs started before it are stale
  (`app_describe.run` says so; `runs_get`, `runs_cancel` and
  `outputs_download` return `RUN_STALE`). An end the tools miss is a touch,
  which only asks.
- **Not counted.** The agent's dialogs, the shared bar and its dialogs, page
  scrolling (a wheel elsewhere, a scroll key with nothing focused), pointer
  movement, modifier keys, Tab and focus changes; a cross-origin frame's events
  never reach the page. A run's own loads are untrusted and change nothing, so
  reruns keep their files.

A shadow root attached to an element that is neither inserted later nor a
custom element defined later is not searched for frames; its own events still
pass window.

A check when a call starts is not enough: a call awaits the page, a prompt or
a fetch, and the person can act meanwhile. Every counted event therefore
starts a new turn, and every tool call reaches the page's automation, the
prompts and the fetchers only through `examinedCall`, which checks the turn
before each request and after each answer, and the tool checks once more
before it returns. A call the person interrupts returns `EXAMINATION_CHANGED`
and does nothing more: no report, download, viewer load or held file from it.
The turn's signal also closes its prompts, drops those still queued unshown,
and stops its fetches and waits; the agent's own signal is kept apart, so the
person looking at the viewer never cancels the agent's run. A components test
enumerates every tool, on an untouched and on a touched examination, and
interrupts it after each answer it awaits.

The read-only viewer tools read what the viewer shows whatever the
examination's state, because the person sees the same image.

`pageFiles` lists what each classified input received from its change,
`input` (for an input in an open shadow root) and `nd-files` events, and files
dropped on the page or handed over by `takeHandoff` that reach no input
(`received:drop`, `received:handoff`). It says what the page was given, not
what it shows: NiiMath shows the agent's scan through its own loader without
an event, and DWI2TRX refuses a NIfTI dropped without its gradient files, so
no event tells the tools what the page holds. `inputs_use_page_files`
therefore always shows the person the files and asks first, and a run or
viewer load the tools start clears the record. A pick made while a run is
going is not recorded, since the busy app may ignore it.
`pageMayHoldOtherInputs` turns true once the person has done something whose
effect the tracker cannot see, such as using a control or an unclassified
input. An app whose list changes without a change event may leave a stale
entry; using it still shows the person the files first.

An example's file roles serve the page's example selector and sometimes differ
from the contract's. The example's `automation` field in `examples.json` maps
them, leaves files out with a `reason`, translates page parameters into
contract parameters (`parameters`), or says why the example is `unavailable`
(`webmcp/examples.js`). `node scripts/webmcp-examples.mjs` reports every app's
examples and fails when an example's operation requires a parameter the
example does not give.

WebMCP has no way to ask the person anything. `createAgentPrompts()` provides
the questions, file requests and fetch approvals as `dialog.nd-dialog`
dialogs. One shows at a time and the others wait; a prompt that fails to
render rejects only its own call. Each says that an AI agent the person
started is asking. Closing a dialog declines it, and an aborted call closes it.
A consent dialog (fetch approval, page files, resume) names state: it takes a
function for its request, reads it when it shows and again when the person
presses Allow, shows the current state in place and asks again when the two
differ, and resolves to the request the person allowed, which the tools apply
only while it is still current. The refresh replaces only the text that names
the request, so the buttons and the focus on Allow stay; Escape, the close
control and the backdrop decline, before and after a refresh, and none of them
counts as the person using the page. Requests compare by what they name:
roles, names, sizes, the checksum a file was verified against or the File
itself, and the run. After three changes the dialog closes as declined, and
the tools ask again after Allow at most three times, so an agent cannot keep a
person answering. A components test enumerates every prompt and fails on
one that is neither such a consent dialog nor free of state.

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
  measurements, viewer state (including the value under the crosshair, volume
  names and image statistics) and the answers typed into its dialogs; it can
  read what the viewer shows whenever it asks, as the person sees it; it runs
  the app only on files the person chose, already opened, or the app's
  examples, using opened files only once the person confirms them; once the
  person uses the page a request it already started does nothing more, and it
  uses its files and earlier results again only after the person allows it,
  while opening other files, picking an example or declining releases them;
  it can move and restyle the viewer but not capture it or save images from
  it; it fetches an address only after the person allows it, and for a store
  the dialog names the address the app reads under, and the app reads only
  under it, following no redirect; it can save run outputs to downloads; an
  agent in the cloud sends what it reads to its provider.
- **Tested.** Node tests build the table from every app's `automation.json`
  and check that each run schema accepts and refuses the same parameters as
  the contract, both through a JSON Schema reader and through the tools' own
  input check, including inherited names, near multiples and unsafe
  integers; they also cover the examination lifetime, run binding in the
  automation, the bounded run memory, the nv-mcp method and parameter tables
  and their audit, redirect refusal, fetch approval, the store root of a URL
  input, the interaction predicate, and every tool interrupted after each
  answer it awaits (held promises, not timers).
  `pnpm --filter @neurodesk/agent-server validate:webmcp` runs a whole Brain
  Extraction analysis through Chrome's own WebMCP: example, run, viewer, both
  dialogs, the real file chooser, a rerun with another threshold, a file the
  person opened in the sidebar, and a download.
  `node test/webmcp-examination.smoke.mjs` drives in Chromium what a person
  can do to the agent's files: picking an example in NiiMath, opening a file
  during a run and after one, dropping a file, QSMbly's mask remove button
  (a touch whose resume dialog names the mask), dcm2niix's settings, a drop on DWI2TRX's viewer, a handoff from
  DICOM View to White matter lesions, ZARRo's store approval and its reads
  against a local server that redirects to another (none reaches the second),
  Brain Extraction's viewer permissions, redirect refusal and fetch approval,
  touches from a wheel, a drag and clicks in same-origin frames (one that
  navigates, one added inside an open shadow root, and a click in a frame's
  new document before it loads), and the resume flow: NiiMath's example run,
  a wheel and a click in the viewer, then `runs_get` and `outputs_download`
  after Allow, with the saved mask's SHA-256 equal to the recorded one, a
  declined result after Decline, and nothing to resume after the person opens
  their own file. It also drops a scan on NiiMath's viewer canvas, which the
  shell takes at window (the example run is then stale with no dialog), uses
  the status bar's Undo, runs the person's own command after an agent run
  (Allow returns the agent run's recorded report and bytes), names a run's
  own file apart from a file the agent took since, shares one dialog between
  a report and a download asked for together, removes a NeSVoR stack (a touch
  whose resume dialog names the agent's stack), and
  loads in ZARRo by hand, in the same tab, a store an agent attempt failed
  on.
  `node test/webmcp-interaction.smoke.mjs` holds a file in every app and
  performs each trusted action the workspace offers once the app is ready
  (every classified file and folder input, every remove or clear button, and
  every visible select, changed to another option by keyboard, checkbox, text
  field and canvas, at most 40 per app). Its expectation does not come from
  `interactionEffect`: after each action, with no Allow given, the agent must
  not get the held file back, so the examination is ended or touched and a
  touch makes the next run ask to resume, naming the held files, whatever the
  action changed in the page.
  `node test/page-drop-undo.smoke.mjs` records, for every app with a
  classified file input, what pick, drop and Undo, and pick, the app's own
  remove control, drop and Undo leave: the file names shown and in the inputs,
  each registered viewer's volumes, the files and volumes the app's state
  object holds, and every other control's value. `--diff` compares two builds;
  with it the branch was held to leave every app's Undo as on main.
  `node test/webmcp.smoke.mjs` checks every app of the built site at 1440 and
  390 px in Chrome's own WebMCP (it fails without it unless
  `WEBMCP_STAND_IN=1`): the full tool set, `app_describe` with every loadable
  example, both dialogs, the Privacy statement, each light-DOM file input
  (folder inputs included) listing what it holds, and that a browser without
  WebMCP loads none of its modules. Inputs in shadow roots are reported as not
  covered. On 19 November 2026, after the third review's fixes, all 63 apps
  passed in 360 s. CI runs it in the site-catalog job on the apps the plan
  selects (`SMOKE_APPS`), and on every app when the plan covers the whole
  catalogue; the interaction smoke runs beside it the same way, and the
  examination smoke over its fixed apps on every site build. On 19 November
  2026, after the fourth review's fixes and on a fresh build of the final head,
  the examination smoke passed its 19 checks in 43 to 56 s in each of seven
  runs, two of them beside the interaction smoke. The interaction smoke ran in
  four parallel shards in 758 s: 62 apps passed and ZARRo, which holds no
  files, is named in `test/webmcp-interaction-skips.json`. Of 541 actions, 400
  touched the examination and each made the next run ask to resume, 137 ended
  it, and the 4 not performed are VesselBoost's inference controls, which the
  app keeps disabled until preprocessing has run; the skip list gives that
  reason, and any other unperformed action, or an app with none performed,
  fails. No app had more than 40 actions. `node test/webmcp.smoke.mjs` passed
  all 63 apps in 432 s on that build.
  On 19 November 2026, after the fifth review's fixes and on a fresh build of
  the final head, the examination smoke passed its 27 checks in 77 to 110 s in
  each of three runs beside the other two smokes, and `node
  test/webmcp.smoke.mjs` passed all 63 apps in 453 s. The interaction smoke,
  now holding each action to what the page shows, ran in four parallel shards
  in up to 1,277 s: 61 apps passed and ZARRo is named in the skip list. Of 528
  actions, 313 touched the examination and each made the next run ask to
  resume, 213 ended it and 2 were not performed. VesselBoost failed in that
  run when the agent's file dialog did not take its file within 30 s; it
  passed both of two runs on its own.
- **Full runs.** `WEBMCP_RUNS=1` also loads each app's loadable examples
  (`WEBMCP_EXAMPLES=first`: only the first), runs each with the tool and
  parameters `app_describe` gives and saves an output, through the tools
  only. A run that does not complete fails its app unless
  `test/webmcp-run-skips.json` names the app with the outcome it expects
  (`timed out`, `run failed` with an error pattern, or `no loadable example`)
  and the reason; any other outcome fails. The 18 November figures below
  ran the first example only.
  On 18 November 2026, on 16 cores with SwiftShader WebGPU, 53 apps
  completed. 45 completed within 420 s in four parallel shards: ants,
  ants-denoise, brain-extraction, brain2print, calcium-imaging, carotid-flow,
  dcm2niix, deconvolution, deface, degibbs, dicompare, dicomview,
  disconnectome, dwicorrect, dwidenoise, easy-mp2rage, edgereg, elastix,
  greedy, histo2mri, lcmodel, lightsheet-atlas, me-ica, microsam,
  microscope-qc, mri2vid, n4, nesvor (its viewer operation), neuromorph,
  niimath, omezarr-convert, pipeline-builder, qsmbly, reproin, samsrf, sdc,
  spinalcordtoolbox, spot-detection, stardist, stitching, structure-tensor,
  surfannotate, synthsr and topofit, and noddi on a second pass. Eight more
  completed within 1500 s in two shards: bison (1137 s), browserqc (232 s),
  calmar (406 s), fastprep (693 s), fireants (939 s), gliomoda (873 s), hmc
  (333 s) and vesselboost (605 s). Three still ran past 1500 s: brainqcnet,
  musclemap and white-matter-lesions. Four failed for the GPU, not the tools:
  brainchop (WebGL texture limit), dwi2trx (needs 32-lane subgroups), syncro
  and synthseg (GPU memory). cryo-em, seedseg and zarro have no example the
  tools can load. These ten are the expected skips.
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
