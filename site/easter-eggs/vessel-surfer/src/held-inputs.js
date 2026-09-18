// A key can be held by a keyboard and several touch pointers independently.
export class HeldInputs extends Set {
  sources = new Map();
  press(source, key) {
    this.sources.set(source, key);
    this.sync();
  }
  release(source) {
    this.sources.delete(source);
    this.sync();
  }
  sync() {
    super.clear();
    for (const key of this.sources.values()) super.add(key);
  }
  clear() {
    this.sources.clear();
    super.clear();
  }
}
