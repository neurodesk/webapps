import { vi } from 'vitest';

const events = vi.hoisted((): string[] => []);

vi.mock('@niivue/niivue', () => ({
  SLICE_TYPE: { MULTIPLANAR: 0 },
  MULTIPLANAR_TYPE: { ROW: 0 },
  Niivue: class {
    volumes: { name: string }[] = [];
    async attachToCanvas() { await Promise.resolve(); }
    setMultiplanarLayout() {}
    setSliceType() {}
    async loadVolumes([{ url, name }]: { url: string; name: string }[]) {
      events.push(`start ${url}`);
      await Promise.resolve();
      if (url === 'bad.nii') {
        events.push('failed bad.nii');
        throw new Error('unreadable volume');
      }
      this.volumes = [{ name }];
      events.push(`loaded ${url}`);
    }
    drawScene() {}
    removeVolume() { this.volumes = []; }
  },
}));

beforeEach(() => {
  vi.resetModules();
  events.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,preview');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('a failed renderer finishes before the next queued preview starts', async () => {
  const { getVolumeThumbnail } = await import('./niivueThumbnail');
  const first = getVolumeThumbnail('bad.nii');
  const second = getVolumeThumbnail('good.nii');
  await expect(first).resolves.toBeNull();
  await expect(second).resolves.toBe('data:image/png;base64,preview');
  expect(events).toEqual(['start bad.nii', 'failed bad.nii', 'start good.nii', 'loaded good.nii']);
});

test('a rejected file preparation clears its cached promise so the same file can retry', async () => {
  const create = vi.fn<(blob: Blob) => string>()
    .mockImplementationOnce(() => { throw new Error('object URL unavailable'); })
    .mockReturnValue('blob:ready');
  class ThumbnailURL extends URL {
    static createObjectURL = create;
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal('URL', ThumbnailURL);
  const { getVolumeThumbnailFromFile } = await import('./niivueThumbnail');
  const firstFile = new File(['first'], 'first.nii');
  const rejected = expect(getVolumeThumbnailFromFile(firstFile)).rejects.toThrow('object URL unavailable');
  const next = getVolumeThumbnailFromFile(new File(['second'], 'second.nii'));
  await rejected;
  await expect(next).resolves.toBe('data:image/png;base64,preview');
  await expect(getVolumeThumbnailFromFile(firstFile)).resolves.toBe('data:image/png;base64,preview');
  expect(create).toHaveBeenCalledTimes(3);
});
