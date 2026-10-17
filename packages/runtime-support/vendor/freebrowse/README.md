# Vendored FreeBrowse

FreeBrowse's development branch is not published to npm, so this directory holds
its library build. The shared viewer (`src/freebrowse-viewer`) imports it as
`freebrowse: file:./vendor/freebrowse`. Generated: do not edit by hand.

- Source: https://github.com/pwighton/freebrowse.git
- Branch: `20260929-niivue-mono-fixes-merged`
- Commit: `eae80a127fdd99974c80952e890bf18aa6e9d5dd`
- Built against `@niivue/niivue@1.0.0-rc.17`, the peer this package declares.

## Rebuild

```sh
node packages/runtime-support/scripts/vendor-freebrowse.mjs
pnpm install
```

The script clones the commit into a fresh directory under `$TMPDIR`. The branch links
`@niivue/niivue` to a local niivue-mono checkout, so the script installs
`@niivue/niivue@1.0.0-rc.17` in its place and runs `npm run build:lib`, the
declaration build and `npm pack`. It then unpacks the tarball here, drops source maps,
removes the NiiVue dependency (dist-lib keeps NiiVue external, so it is a peer only) and
the build scripts from `package.json`, and writes this README.

## Known gaps

FreeBrowse's eye button sets a volume's `visible` flag (niivue/mono#224), which no NiiVue
release supports yet. NiiVue stores the flag and keeps drawing the volume, so the shared viewer
(`src/freebrowse-viewer/volume-visibility.js`) hides it through its opacity instead. The declaration
build reports that one type error; the script stops on any other.
