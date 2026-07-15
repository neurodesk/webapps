import { DicomController as SharedDicomController } from '@neurodesk/webapp-components/file-io';

export class DicomController extends SharedDicomController {
  constructor(options = {}) {
    super({ ...options, moduleUrl: new URL('../../dcm2niix/index.js', import.meta.url).href, throwOnError: false });
  }
}
