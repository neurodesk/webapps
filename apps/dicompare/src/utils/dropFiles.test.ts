import type React from 'react';
import { getAllFilesFromDirectory } from './fileUploadUtils';
import { processDroppedFiles } from './workspaceHelpers';

const fileEntry = (file: File) => ({
  isFile: true,
  isDirectory: false,
  file: (ok: (f: File) => void) => setTimeout(() => ok(file), 0),
});

// Directory entry whose reader returns `children` in one batch, then an empty batch.
const dirEntry = (children: unknown[]) => ({
  isFile: false,
  isDirectory: true,
  createReader: () => {
    let done = false;
    return {
      readEntries: (ok: (entries: unknown[]) => void) =>
        setTimeout(() => {
          ok(done ? [] : children);
          done = true;
        }, 0),
    };
  },
});

describe('getAllFilesFromDirectory', () => {
  test('collects files recursively', async () => {
    const a = new File(['a'], 'a.dcm');
    const b = new File(['b'], 'b.dcm');
    const root = dirEntry([fileEntry(a), dirEntry([fileEntry(b)])]);
    const files = await getAllFilesFromDirectory(root as unknown as FileSystemDirectoryEntry);
    expect(files.map(f => f.name)).toEqual(['a.dcm', 'b.dcm']);
  });

  test('rejects when readEntries fails instead of hanging', async () => {
    const root = {
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries: (_ok: unknown, fail: (e: Error) => void) => setTimeout(() => fail(new Error('read failed')), 0),
      }),
    };
    await expect(getAllFilesFromDirectory(root as unknown as FileSystemDirectoryEntry)).rejects.toThrow('read failed');
  });

  test('rejects when a file entry cannot be read', async () => {
    const bad = {
      isFile: true,
      isDirectory: false,
      file: (_ok: unknown, fail: (e: Error) => void) => setTimeout(() => fail(new Error('file failed')), 0),
    };
    const root = dirEntry([bad]);
    await expect(getAllFilesFromDirectory(root as unknown as FileSystemDirectoryEntry)).rejects.toThrow('file failed');
  });
});

describe('processDroppedFiles', () => {
  test('reads every item even when a folder comes first', async () => {
    const inFolder = new File(['x'], 'in-folder.dcm');
    const loose1 = new File(['y'], 'loose1.dcm');
    const loose2 = new File(['z'], 'loose2.dcm');

    // Simulate a real DataTransfer: items become unreadable once the drop
    // event handler yields (i.e. after the first await).
    let live = true;
    const item = (entry: unknown, file: File | null) => ({
      kind: 'file',
      webkitGetAsEntry: () => (live ? entry : null),
      getAsFile: () => (live ? file : null),
    });
    const items = [
      item(dirEntry([fileEntry(inFolder)]), null),
      item(fileEntry(loose1), loose1),
      item(null, loose2),
    ];
    const event = { dataTransfer: { items } } as unknown as React.DragEvent;

    const pending = processDroppedFiles(event);
    live = false;
    const files = await pending;

    expect(files.map(f => f.name).sort()).toEqual(['in-folder.dcm', 'loose1.dcm', 'loose2.dcm']);
  });
});
