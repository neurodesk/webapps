import { setTimeout } from 'node:timers/promises';

// Retry only navigation failures attributable to transport or host availability.
export async function navigateDeployed(page, url, { retries = 3, delay = setTimeout } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (error) {
      if (attempt >= retries || !/net::ERR_(NAME_NOT_RESOLVED|CONNECTION_RESET|TIMED_OUT|CONNECTION_TIMED_OUT)/.test(error.message)) throw error;
    }
    if (response?.ok()) return response;
    if (response && ![429, 502, 503, 504].includes(response.status())) {
      throw new Error(`${url} returned ${response.status()}`);
    }
    if (attempt >= retries) throw new Error(`${url} returned ${response?.status() ?? 'no response'} after ${attempt + 1} attempts`);
    await delay(1000 * 2 ** attempt);
  }
}
