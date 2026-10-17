/**
 * Map from view mode name to NiiVue slice type and render settings.
 */
export declare const sliceTypeMap: {
    [type: string]: {
        sliceType: number;
        showRender: number;
    };
};
/**
 * Convert an RGBA [0-255] tuple to a hex color string (ignoring alpha).
 */
export declare function rgba255ToHex(rgba255: [number, number, number, number]): string;
/**
 * Convert a Uint8Array to a base64 string efficiently for large arrays.
 */
export declare function uint8ArrayToBase64(uint8Array: Uint8Array): string;
/**
 * Gzip a byte array with the browser-native `CompressionStream('gzip')`.
 *
 * niivue-mono's `saveVolume` returns raw (uncompressed) bytes only for an empty
 * filename — a `.gz` filename triggers a browser download instead of returning
 * bytes. So the AI upload path exports raw bytes via `saveVolume({filename:''})`
 * and gzips them here (matching old FreeBrowse's `saveToUint8Array(name.gz)`),
 * with no extra dependency.
 */
export declare function gzipUint8Array(bytes: Uint8Array): Promise<Uint8Array>;
