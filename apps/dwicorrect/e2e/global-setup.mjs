// Build the phantom once before any test: the release cargo build can take longer than a
// test's timeout on a cold CI runner.
import { phantomDir } from "./fixtures.mjs";

export default function globalSetup() {
  phantomDir();
}
