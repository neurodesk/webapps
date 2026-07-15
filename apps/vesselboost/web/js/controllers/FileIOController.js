import { SimpleFileIOController } from '@neurodesk/webapp-components/file-io';

export class FileIOController extends SimpleFileIOController {
  constructor(options = {}) {
    super({ ...options, dcm2niixModuleUrl: new URL('../../dcm2niix/index.js', import.meta.url).href });
  }
}
