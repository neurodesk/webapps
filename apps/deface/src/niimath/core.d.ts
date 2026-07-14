import type { Operators, ImageProcessorMethods, DataType } from './types';
export type { Operators, OperatorDefinition, ImageProcessorMethods, MeshOptions, BitmapOptions, DataType } from './types';
export declare const dataTypes: {
    readonly char: "char";
    readonly short: "short";
    readonly int: "int";
    readonly float: "float";
    readonly double: "double";
    readonly input: "input";
};
/**
 * Factory that constructs the WASM-backed Web Worker for a build. The BSD entry
 * point (index.ts) and the GPL entry point (index-gpl.ts) each supply their own
 * factory so that esbuild can statically discover and bundle the correct worker
 * (worker.js vs worker-gpl.js) and its WASM binary. The `new Worker(new URL(...))`
 * literal must live in the entry module for esbuild's worker code-splitting to
 * resolve it, which is why this is injected rather than hard-coded here.
 */
export type WorkerFactory = () => Worker;
/**
 * Niimath runs one WASM worker per instance. **Single-flight contract:** only one
 * `.run()` may be in flight per `Niimath` instance at a time — `run()` reassigns the
 * worker's single `onmessage` handler, so two overlapping runs on the same instance
 * cross-wire each other's results (the first promise can hang or resolve with the
 * wrong output). Serialize calls (await the previous `run()` before the next), or
 * create a separate `Niimath` instance per concurrent stream.
 *
 * This base class is shared by the BSD and GPL builds; the only difference is the
 * `WorkerFactory` injected via the constructor. Consumers normally use the concrete
 * `Niimath` exported from the package entry points, not this class directly.
 */
export declare class NiimathBase {
    private worker;
    readonly operators: Operators;
    private outputDataType;
    readonly dataTypes: {
        readonly char: "char";
        readonly short: "short";
        readonly int: "int";
        readonly float: "float";
        readonly double: "double";
        readonly input: "input";
    };
    private readonly workerFactory;
    constructor(operators: Operators, workerFactory: WorkerFactory);
    init(): Promise<boolean>;
    setOutputDataType(type: DataType): void;
    image(file: File): ImageProcessor;
}
interface ImageProcessorConfig {
    worker: Worker | null;
    file: File;
    operators: Operators;
    outputDataType?: DataType;
}
declare class ImageProcessor {
    private worker;
    private file;
    private operators;
    private commands;
    private outputDataType;
    private extraFiles;
    private stagedCounter;
    [key: string]: unknown;
    constructor({ worker, file, operators, outputDataType }: ImageProcessorConfig);
    private _addCommand;
    private _addFileCommand;
    deface(tmpl: File, mask: File, opts?: (string | number)[]): this;
    spmDeface(tmpl: File, mask: File, opts?: (string | number)[]): this;
    spmcoreg(ref: File, opts?: (string | number)[]): this;
    allineate(base: File, opts?: (string | number)[]): this;
    resliceNN(ref: File): this;
    mulImage(img: File): this;
    private _generateMethods;
    run(outName?: string): Promise<Blob>;
}
interface FileOperandMethods {
    deface(tmpl: File, mask: File, opts?: (string | number)[]): this;
    spmDeface(tmpl: File, mask: File, opts?: (string | number)[]): this;
    spmcoreg(ref: File, opts?: (string | number)[]): this;
    allineate(base: File, opts?: (string | number)[]): this;
    resliceNN(ref: File): this;
    mulImage(img: File): this;
}
interface ImageProcessor extends ImageProcessorMethods, FileOperandMethods {
}
export { ImageProcessor };
//# sourceMappingURL=core.d.ts.map