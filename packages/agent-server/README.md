# @neurodesk/agent-server

`neurodesk-mcp` lets an AI agent on your computer view and control the viewer
of a Neurodesk webapp you have open in your browser. It is
[nv-mcp](https://www.npmjs.com/package/@niivue/nv-mcp)'s server for Node: the
agent calls its MCP endpoint, and each page you connect is a tab with nv-mcp's
tools (`list_tabs`, `where_am_i`, `go_to_point`, `set_view`, `screenshot`, …).

The desktop app serves the same tools itself; this is for the hosted apps.

## Use

```sh
node packages/agent-server/src/cli.js          # or: pnpm --filter @neurodesk/agent-server start
claude mcp add --transport http neurodesk http://127.0.0.1:4242/mcp
```

Then open an app with `?agent`, for example
`https://webapps.neurodesk.org/brain-extraction/?agent`, open an image and
choose **Connect an agent**. The status bar at the bottom of the page says when
it is connected and which tab ID it is.

- **Chrome** asks to allow access to devices on your local network. Allow it.
- **Firefox** connected without asking in the one test so far, on macOS.
- **Safari** cannot connect to a local server from an HTTPS page. Use the
  desktop app, Chrome or Firefox.

If the page keeps waiting, either the server is not running or the browser
refused; the page cannot tell which.

## Options

- `--port <n>`: listen on another port (default 4242, which nv-mcp's own
  servers also use). Open the app with `?agent=<n>` to match.
- `--allow-origin <origin>`: also accept pages from this origin, for example a
  staging site. Pages on `localhost`, `127.0.0.1` and `[::1]` are always
  accepted, as is `https://webapps.neurodesk.org`.

The server listens on `127.0.0.1` only, and `/mcp` refuses requests whose
`Host` is not this server's, against DNS rebinding.

## What a connected agent receives

A connected page answers the agent's tool calls with screenshots of its
viewer and details of the loaded images, such as their names, dimensions and
intensity statistics. The server passes these answers to the agent on your
computer. An agent that runs on a cloud model sends them to its provider.

## What an agent can load

The page loads volumes itself, so `load_volume` and the other loading tools
can fetch only http(s) URLs that let the page read them under CORS. A path on
your computer cannot be loaded. There is no approval step yet, unlike the
desktop app.

## An agent built into your browser (WebMCP)

A browser with [WebMCP](https://webmachinelearning.github.io/webmcp/) needs no
server. Every app registers its tools with the browser's own agent: it can read
what the app does, load an example, use the files you opened or ask you for
others, run an analysis, show the result in the viewer and save an output. When
it needs a decision, a dialog says that an AI agent is asking; closing it
declines. The tools use the same names on every app; RFC 0011 lists them.

No browser turns WebMCP on by default yet. To try it in Chrome:

1. In a Chrome build that has the flag (Canary, or Chrome for Testing), open
   `chrome://flags/#enable-webmcp-testing`, set it to **Enabled** and
   relaunch. Playwright's Chromium takes `--enable-features=WebMCPTesting`.
2. Open any app, for example `https://webapps.neurodesk.org/brain-extraction/`.
3. Start the browser's agent and ask it, for example, to extract the brain from
   the example and save the mask.

Each app's Privacy dialog says what the agent can read. A host that holds a
Chrome origin trial token (`webmcp_origin_trial` in `registry/apps.yml`) offers
the tools without the flag.

## Development

```sh
pnpm --filter @neurodesk/agent-server test
pnpm --filter brain-extraction build && pnpm --filter @neurodesk/agent-server validate:browser
pnpm --filter brain-extraction build && pnpm --filter @neurodesk/agent-server validate:webmcp
```

`validate:browser` serves the built Brain Extraction app at its hosted address
in each installed Playwright browser and drives it from an MCP client on port
4343.
