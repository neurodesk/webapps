# @neurodesk/dicompare

## 0.15.20261113

## 0.15.20261111

## 0.15.20261110

## 0.15.20261109

## 0.15.20261108

## 0.15.20261106

### Patch Changes

- 0e92d6e: Restore the landing page at / and move the workspace to /workspace. A strip under the Neurodesk bar links Home, Workspace and the Schema Library and shows the dicompare-web release the deployment is synced to. Files handed over from another app still open in the workspace. The upstream sync now follows dicompare-web releases instead of main.
- 0e92d6e: Merge upstream astewartau/dicompare-web v0.15.5 (d3d0879..5dbbeea):

  - Fix spine and ABCD library schemas
  - Merge pull request #33 from astewartau/fix/spine-abcd-schemas
  - Serve the GitHub Pages build from /dicompare-web/
  - Merge pull request #35 from astewartau/fix/pages-subpath-base
  - chore: bump version to 0.15.5

## 0.15.20261104

## 0.15.20261103

## 0.15.20261031

## 0.15.20261027

## 0.15.20261024

## 0.15.20261022

## 0.15.20261020

## 0.15.20261019

## 0.15.20261018

## 0.15.20261017

### Patch Changes

- Report asynchronous UI failures through the status footer and technical log, retain awaited session loading, and allow failed thumbnail preparation to retry.

  Retain the command line's schema-generation Python after upstream moved web schema exports to JavaScript. Its generated schema and reference outputs are unchanged.

## 0.15.20261016

## 0.15.20261015

### Minor Changes

- 81ec8a2: Add the `dicompare` portable command line. It runs the web app's Pyodide build
  and pinned dicompare wheel in Node, offline, with the worker's own Python calls:
  `analyze`, `compare` (the compliance report) and `build-schema`, plus the app's
  schema library. Its reports match the web app's downloads.
