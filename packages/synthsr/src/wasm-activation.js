const PAGE_ELEMENTS = 8 * 1024 * 1024;

// A full activation can exceed the browser's single ArrayBuffer limit.
// Page its storage only; operator slabs still see contiguous, exact values.
export class WasmActivation {
  constructor(length, pageElements = PAGE_ELEMENTS) {
    this.length = length;
    this.pageElements = pageElements;
    this.pages = [];
  }

  set(source, offset = 0) {
    let copied = 0;
    while (copied < source.length) {
      const position = offset + copied;
      const index = Math.floor(position / this.pageElements);
      const within = position % this.pageElements;
      const page = this.pages[index] ??= new Float32Array(
        Math.min(this.pageElements, this.length - index * this.pageElements),
      );
      const count = Math.min(source.length - copied, page.length - within);
      page.set(source.subarray(copied, copied + count), within);
      copied += count;
    }
  }

  copyTo(target, offset, start, end) {
    let position = start;
    while (position < end) {
      const index = Math.floor(position / this.pageElements);
      const within = position % this.pageElements;
      const count = Math.min(end - position, this.pageElements - within);
      target.set(this.pages[index].subarray(within, within + count), offset);
      position += count;
      offset += count;
    }
  }
}
