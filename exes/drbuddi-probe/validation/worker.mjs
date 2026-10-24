import createModule from './out/drbuddi-probe.mjs';
self.onmessage = async ({ data: schedule }) => {
  let module;
  try {
    module = await createModule({
      print: (message) => postMessage({ type: 'log', message }),
      printErr: (message) => postMessage({ type: 'log', message }),
    });
    for (const [name, path] of [['up','blip_up_b0'],['down','blip_down_b0']]) {
      const response = await fetch(`./inputs/${path}.nii`);
      if (!response.ok) throw new Error(`Input ${path}: ${response.status}`);
      module.FS.writeFile(`/${name}.nii`,new Uint8Array(await response.arrayBuffer()));
    }
    const args = ['/up.nii', '/down.nii', '1', '/out'];
    if(schedule) for(const stage of schedule) args.push('--DRBUDDI_stage',stage);
    const start=performance.now();
    const status=module.callMain(args);
    const elapsedMs=performance.now()-start;
    if(status !== 0) throw new Error(`Probe failed: ${status}`);
    const outputs=['up','down'].map(name=>({name,bytes:module.FS.readFile(`/out-${name}.nii`)}));
    postMessage({type:'done', elapsedMs, heapBytes:module.HEAPU8.buffer.byteLength,outputs},outputs.map(output=>output.bytes.buffer));
  } catch (error) {
    postMessage({ type: 'error', message: String(error), heapBytes: module?.HEAPU8?.buffer.byteLength });
  }
};
