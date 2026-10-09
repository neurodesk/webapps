export async function waitForAppIsolation(page, appId, url) {
  try {
    await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30000 });
  } catch (cause) {
    throw new Error(`${appId}: cross-origin isolation check failed at ${url}`, { cause });
  }
}
