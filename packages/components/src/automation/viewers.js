const clone = value => structuredClone(value);
const sliceTypes = ['axial', 'coronal', 'sagittal', 'multiplanar', 'render'];

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function displayUpdate(update, count) {
  const { index, colormap, opacity, calMin, calMax, visible, ...rest } = update ?? {};
  if (Object.keys(rest).length) throw new Error(`Unsupported volume display fields: ${Object.keys(rest).join(', ')}`);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`Unknown volume index: ${index}`);
  const options = {};
  if (colormap !== undefined) {
    if (typeof colormap !== 'string' || !colormap) throw new Error('colormap must be a colormap name.');
    options.colormap = colormap;
  }
  if (opacity !== undefined) {
    options.opacity = finite(opacity, 'opacity');
    if (opacity < 0 || opacity > 1) throw new Error('opacity must be between 0 and 1.');
  }
  if (calMin !== undefined) options.calMin = finite(calMin, 'calMin');
  if (calMax !== undefined) options.calMax = finite(calMax, 'calMax');
  if (options.calMin !== undefined && options.calMax !== undefined && options.calMin > options.calMax) throw new Error('calMin must not exceed calMax.');
  if (visible !== undefined) {
    if (typeof visible !== 'boolean') throw new Error('visible must be a boolean.');
    options.visible = visible;
  }
  return { index, options };
}

/**
 * @param {any} nv
 * @param {{ tabs?: any, regions?: any }} [options]
 */
export function createNiivueAdapter(nv, { tabs, regions } = {}) {
  let location = null;
  const context = nv.createExtensionContext?.();
  context?.on('locationChange', event => {
    const detail = event.detail;
    location = { mm: Array.from(detail.mm ?? []), values: clone(detail.values ?? []) };
  });
  const crosshair = typeof nv.getCrosshairPos === 'function' && typeof nv.setCrosshairPos === 'function';
  const layers = Array.isArray(nv.volumes);
  // NiiVue 1.0 exposes setVolume and a sliceType property; 0.x viewers stay read-only.
  const display = layers && typeof nv.setVolume === 'function' && typeof nv.sliceType === 'number';
  // nv-mcp answers its tool vocabulary from the live scene; it is loaded only when an agent first calls it.
  let agent;
  const nvMcp = () => agent ??= import('./nv-mcp.js').then(({ AgentClient, coreHandlers, sceneState }) => {
    const host = { view: nv };
    return { AgentClient, handlers: coreHandlers(host), state: () => sceneState(host) };
  }).catch(error => {
    agent = undefined;
    throw error;
  });
  const niivue = async (method, params = {}) => {
    const { handlers, state } = await nvMcp();
    // Results cross a JSON wire to the MCP server, so they are returned as that wire would carry them.
    const wire = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    if (method === undefined) return { state: wire(state()) };
    if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown NiiVue method: ${method}`);
    const result = await handlers[method](params);
    return { result: wire(result), state: wire(state()) };
  };
  return {
    state: () => ({
      position: crosshair ? { frame: 'mm', value: Array.from(nv.getCrosshairPos()) } : null,
      location: clone(location),
      ...(display && { sliceType: sliceTypes[nv.sliceType] ?? null }),
      ...(tabs && { tabs: clone(tabs.list()) }),
    }),
    ...(layers && { volumes: () => nv.volumes.map((volume, index) => ({
      index,
      name: volume.name ?? null,
      colormap: volume.colormap ?? null,
      calMin: volume.calMin ?? volume.cal_min ?? null,
      calMax: volume.calMax ?? volume.cal_max ?? null,
      opacity: volume.opacity ?? null,
      visible: volume.visible !== false && (volume.opacity ?? 1) > 0,
      dims: Array.from(volume.dims ?? volume.hdr?.dims ?? []),
    })) }),
    ...(display && { setDisplay: async ({ sliceType, volumes = [] }) => {
      if (sliceType !== undefined && !sliceTypes.includes(sliceType)) throw new Error(`sliceType must be one of: ${sliceTypes.join(', ')}`);
      if (!Array.isArray(volumes)) throw new Error('volumes must be a list of volume display updates.');
      const updates = volumes.map(update => displayUpdate(update, nv.volumes.length));
      for (const { index, options } of updates) await nv.setVolume(index, options);
      if (sliceType !== undefined) nv.sliceType = sliceTypes.indexOf(sliceType);
    } }),
    ...(nv.canvas && {
      canvas: () => nv.canvas,
      // Draw now and wait for the frame to present so a capture sees the latest display state.
      frame: async () => {
        nv.drawScene?.();
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf === 'function') for (let index = 0; index < 2; index++) await new Promise(resolve => raf(resolve));
      },
    }),
    ...(crosshair && { setCrosshair: ({ frame, value }) => {
      if (frame !== 'mm' || !Array.isArray(value) || value.length !== 3 || !value.every(number => Number.isFinite(number))) {
        throw new Error('Crosshair position requires three finite millimetre coordinates.');
      }
      nv.setCrosshairPos([...value]);
    } }),
    ...(display && { niivue, nvMcp }),
    ...(tabs && { tabs }),
    ...(regions && { regions }),
  };
}

export function createViewerRegistry() {
  const viewers = new Map();
  function get(id) {
    if (!viewers.has(id)) throw new Error(`Unknown viewer: ${id}`);
    return viewers.get(id);
  }
  return {
    register(id, adapter) {
      if (!/^[a-z][a-z0-9-]*$/.test(id) || !adapter || typeof adapter.state !== 'function') throw new Error('A viewer needs a valid ID and a state function.');
      if (viewers.has(id)) throw new Error(`Viewer already registered: ${id}`);
      viewers.set(id, adapter);
      return () => viewers.delete(id);
    },
    list() {
      return [...viewers].map(([id, adapter]) => ({ id, capabilities: {
        state: true, crosshair: typeof adapter.setCrosshair === 'function', tabs: Boolean(adapter.tabs), regions: Boolean(adapter.regions),
        volumes: typeof adapter.volumes === 'function', display: typeof adapter.setDisplay === 'function', screenshot: typeof adapter.canvas === 'function',
        niivue: typeof adapter.niivue === 'function',
      } }));
    },
    /** The viewer an agent drives: `main` when it answers nv-mcp, otherwise the first that does. */
    niivue() {
      const entries = [...viewers].filter(([, adapter]) => typeof adapter.nvMcp === 'function');
      return (entries.find(([id]) => id === 'main') ?? entries[0])?.[1] ?? null;
    },
    async dispatch(command, request) {
      if (command === 'viewers.list') return this.list();
      const adapter = get(request.viewerId);
      if (command === 'viewers.state') return clone(await adapter.state());
      if (command === 'viewers.crosshair') {
        if (!adapter.setCrosshair) throw new Error('This viewer does not support crosshair control.');
        await adapter.setCrosshair(request.position);
        return clone(await adapter.state());
      }
      if (command === 'viewers.tab') {
        if (!adapter.tabs) throw new Error('This viewer does not expose tabs.');
        if (!adapter.tabs.list().some(tab => tab.id === request.tabId)) throw new Error(`Unknown viewer tab: ${request.tabId}`);
        await adapter.tabs.select(request.tabId);
        return clone(await adapter.state());
      }
      if (command === 'viewers.regions') {
        if (!adapter.regions) throw new Error('This viewer does not expose regions.');
        return clone(await adapter.regions.list());
      }
      if (command === 'viewers.volumes') {
        if (!adapter.volumes) throw new Error('This viewer does not expose volumes.');
        return clone(await adapter.volumes());
      }
      if (command === 'viewers.display') {
        if (!adapter.setDisplay) throw new Error('This viewer does not support display control.');
        await adapter.setDisplay({ sliceType: request.sliceType, volumes: request.volumes });
        return { ...clone(await adapter.state()), volumes: adapter.volumes ? clone(await adapter.volumes()) : [] };
      }
      if (command === 'viewers.niivue') {
        if (!adapter.niivue) throw new Error('This viewer does not support NiiVue agent tools.');
        const { method, params } = request;
        if (method !== undefined && (typeof method !== 'string' || !method)) throw new Error('method must be a NiiVue tool name.');
        if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) throw new Error('params must be an object.');
        return adapter.niivue(method, params);
      }
      if (command === 'viewers.canvas') {
        if (!adapter.canvas) throw new Error('This viewer does not support screenshots.');
        await adapter.frame?.();
        const canvas = adapter.canvas();
        canvas?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        const rect = canvas?.getBoundingClientRect?.();
        if (!rect || rect.width < 1 || rect.height < 1) throw new Error('The viewer canvas is not visible.');
        return { x: Math.floor(rect.left), y: Math.floor(rect.top), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
      }
      throw new Error(`Unknown viewer command: ${command}`);
    },
  };
}
