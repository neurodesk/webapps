// libav.js with libvpx (VP9 encode and decode), single-threaded WebAssembly in this process.
// The command line encodes with it; its self-check and release check decode with it.
import LibAVFactory from '@libav.js/variant-vp9-opus';

let instance;

export function libav() {
  instance ??= LibAVFactory.LibAV({ noworker: true, nothreads: true }).then(async (av) => {
    await av.av_log_set_level(av.AV_LOG_ERROR);
    return av;
  });
  return instance;
}
