# @neurodesk/dicompare

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
