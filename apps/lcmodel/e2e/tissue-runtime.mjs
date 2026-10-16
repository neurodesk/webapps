// The host's proxy is available to Node fetch, but Chromium does not inherit it.
export async function proxyAssets(page) {
  if (!process.env.NEURODESK_TEST_PROXY_FETCH) return;
  await page.context().route("https://huggingface.co/**", async route => {
    const response = await fetch(route.request().url());
    await route.fulfill({
      status: response.status,
      body: Buffer.from(await response.arrayBuffer()),
      headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream", "access-control-allow-origin": "*" },
    });
  });
}

// After "Fit done" NiiVue is still updating the 256 × 256 × 204 T1 and its
// overlays. In headless Chromium's software WebGL, updateOverlays' readPixels
// blocks the page for 3-9 s (profiled), and a file chosen meanwhile is
// imported only once it ends: allow for that before the replacement shows.
export const REPLACEMENT_TIMEOUT = 60000;

export async function forceCpu(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined });
    const original = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (kind, ...args) {
      return kind === "webgl2" ? null : original.call(this, kind, ...args);
    };
  });
}
