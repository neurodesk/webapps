// Ambient declarations for third-party packages that ship no TypeScript types.
// This file must stay a script (no top-level import/export) so `declare module`
// is treated as an ambient module declaration.

// @niivue/dcm2niix ships no type declarations. Declare the small surface we use:
// `new Dcm2niix()`, `.init()`, and a chainable `.input(files).run()` returning Files.
declare module '@niivue/dcm2niix' {
  export class Dcm2niix {
    constructor();
    init(): Promise<void>;
    input(files: File[]): { run(): Promise<File[]> };
  }
}
