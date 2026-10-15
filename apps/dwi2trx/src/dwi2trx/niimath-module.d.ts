/**
 * Minimal typing for the raw Emscripten niimath module (the dtifit CLI mode
 * needs multi-file FS staging + callMain, which the @niivue/niimath chain-API
 * worker can't express). Built locally; see vendor/niimath.
 */
declare module '@niivue/niimath/niimath.js' {
  export interface NiimathModule {
    FS_createDataFile(
      parent: string,
      name: string,
      data: Uint8Array,
      canRead: boolean,
      canWrite: boolean,
    ): void
    FS_readFile(name: string): Uint8Array<ArrayBuffer>
    FS_unlink(name: string): void
    callMain(args: string[]): number
  }
  const Module: (overrides?: Record<string, unknown>) => Promise<NiimathModule>
  export default Module
}
