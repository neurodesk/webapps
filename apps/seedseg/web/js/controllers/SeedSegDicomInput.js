import { DicomController as SharedDicomController, isNiftiFile } from '@neurodesk/webapp-components/file-io';

export class SeedSegDicomInput extends SharedDicomController {
  constructor(options = {}) {
    super({
      ...options,
      moduleUrl: new URL('../../dcm2niix/index.jpeg.js', import.meta.url).href,
      throwOnError: false,
      onDicomFiles: options.onFilesRetained,
      // SeedSeg buckets every converted NIfTI (T1w vs other), not just the first.
      onConversionComplete: (firstNifti, resultFiles) =>
        options.onConversionComplete?.(Array.from(resultFiles || []).filter(isNiftiFile))
    });
  }
}
