/** 256^3 voxels x the channel stride x 2 bytes: one f16 activation, 512 MiB. */
export declare const ACTIVATION_BYTES: number;
export interface DeviceReport {
    supported: boolean;
    /** Why not, in the caller's terms. Empty when supported. */
    reasons: string[];
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
    hasShaderF16?: boolean;
}
/**
 * Ask whether this browser can run the model on WebGPU, without running it.
 * Requests an adapter but never a device, so it is cheap and side-effect free.
 */
export declare function checkSupport(): Promise<DeviceReport>;
/** Acquire a device sized for the model, or refuse and say which limit was short. */
export declare function acquireDevice(): Promise<GPUDevice>;
/** Refuse a caller-supplied device that cannot hold one activation. */
export declare function checkDevice(device: GPUDevice): void;
