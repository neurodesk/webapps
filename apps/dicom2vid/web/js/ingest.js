// Folder and file ingest. Entries are captured synchronously from the drop event
// (dataTransfer.items empties after the handler returns), then the directory tree
// is walked. A webkitdirectory picker is the fallback. Everything stays local.

function fileRecord(file, path) {
  return { name: path || file.webkitRelativePath || file.name, file };
}

// Capture entries synchronously, then walk. Returns [{ name, file }].
export async function collectFromDrop(dataTransfer) {
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const entries = [];
  const looseFiles = [];
  for (const it of items) {
    const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else if (it.getAsFile) { const f = it.getAsFile(); if (f) looseFiles.push(fileRecord(f, f.name)); }
  }

  const out = [...looseFiles];
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    await walkEntry(entry, '', out);
  }
  if (out.length === 0 && dataTransfer.files) {
    for (const f of Array.from(dataTransfer.files)) out.push(fileRecord(f, f.name));
  }
  return out;
}

function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => { out.push(fileRecord(f, prefix + entry.name)); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (!batch.length) {
            for (const child of all) {
              // eslint-disable-next-line no-await-in-loop
              await walkEntry(child, `${prefix + entry.name}/`, out);
            }
            resolve();
          } else {
            all.push(...batch);
            readBatch();
          }
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

export function collectFromPicker(fileList) {
  return Array.from(fileList).map((f) => fileRecord(f, f.webkitRelativePath || f.name));
}

export function readAsArrayBuffer(file) {
  return file.arrayBuffer();
}

// Read a small prefix for header sniffing/grouping without loading the whole file.
export async function readPrefix(file, bytes = 262144) {
  const slice = file.slice(0, Math.min(bytes, file.size));
  return await slice.arrayBuffer();
}
