export class WasmActivation {
  constructor(length, chunkElements = 8 * 1024 * 1024) {
    this.length = length;
    this.chunkElements = chunkElements;
    this.chunks = [];
    for (let start = 0; start < length; start += chunkElements) {
      this.chunks.push(new Float32Array(Math.min(chunkElements, length - start)));
    }
  }

  copyTo(destination, start = 0, end = this.length, offset = 0) {
    while (start < end) {
      const chunk = this.chunks[Math.floor(start / this.chunkElements)];
      const localStart = start % this.chunkElements;
      const count = Math.min(end - start, chunk.length - localStart);
      destination.set(chunk.subarray(localStart, localStart + count), offset);
      start += count;
      offset += count;
    }
  }

  set(source, offset = 0) {
    let start = 0;
    while (start < source.length) {
      const chunk = this.chunks[Math.floor(offset / this.chunkElements)];
      const localStart = offset % this.chunkElements;
      const count = Math.min(source.length - start, chunk.length - localStart);
      chunk.set(source.subarray(start, start + count), localStart);
      start += count;
      offset += count;
    }
  }
}

export function activationUses(nodes, initializers) {
  const uses = new Map([[nodes.at(-1).output, 1]]);
  for (const node of nodes) {
    for (const name of node.inputs) {
      if (name && !initializers[name]) uses.set(name, (uses.get(name) || 0) + 1);
    }
  }
  return uses;
}

export function releaseConsumedActivations(activation, remaining, inputs) {
  for (const name of inputs) {
    if (!remaining.has(name)) continue;
    const left = remaining.get(name) - 1;
    remaining.set(name, left);
    if (left === 0) activation.delete(name);
  }
}
