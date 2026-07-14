export interface EmscriptenModule {
    FS_createDataFile(parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean): void;
    callMain(args: string[]): number;
    FS_readFile(filename: string): Uint8Array;
    FS_unlink(filename: string): void;
}
export type EmscriptenModuleFactory = (overrides?: Record<string, unknown>) => Promise<EmscriptenModule>;
export declare function setupWorker(ModuleFactory: EmscriptenModuleFactory): void;
//# sourceMappingURL=workerImpl.d.ts.map