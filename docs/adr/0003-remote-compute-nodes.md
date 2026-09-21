# ADR-0003: Decouple GPU-bound methods through a user-operated compute server

- Status: accepted
- Date: 2026-09-21

## Context

Every catalog app runs its scientific method inside the browser. NeSVoR, the first
fetal slice-to-volume reconstruction app, trains an implicit neural representation
with custom CUDA kernels for minutes on a data-centre GPU. No browser runtime can
execute the validated upstream method, and a port would be a different, unvalidated
implementation. Clinics that own such a GPU want to keep using the hosted web
frontend while the data never leaves their network. The analysis is in
[nesvor-remote-compute.md](../architecture/nesvor-remote-compute.md).

## Decision

Add one compute server, `neurodesk-compute` (`exes/compute-server`, Rust), that runs
pinned Neurodesk containers on the user's own machine and exposes a small
token-protected HTTP and Server-Sent Events API (protocol v1). The webapp keeps the
data handling, review and download in the browser and sends jobs to the server the
user names in a shared connection panel. The server can also serve the built webapp
itself, so a clinic can use it on a plain LAN origin without the hosted site.

Rules that follow:

- The webapp's Privacy and About text state that inputs travel to the configured
  server and nowhere else. The shared "runs entirely in your browser" sentence is
  overridable per app through `execution` in `registry/app-information.yml`.
- The server never runs caller-supplied command lines; each tool definition maps a
  validated job specification to `argv` and pins the container digest.
- A Node reference server implements the same protocol for browser and desktop
  tests. One conformance test runs against both implementations.
- No relay, broker or Neurodesk-hosted GPU exists. A simulated tool exists for
  connectivity checks and tests and is always labelled as simulated.
- The desktop suite admits only the origins listed in `NEURODESK_COMPUTE_ORIGINS`.

## Consequences

- Apps with GPU-bound upstream methods can join the catalog without a browser port.
- Clinics take on running a GPU host, Docker or Apptainer and, for the hosted
  frontend, a certificate. The install text spells this out.
- Two protocol implementations must stay in step; the conformance test is the gate.
- The catalog's "browser-native" statement is no longer universal and is now
  declared per app.
