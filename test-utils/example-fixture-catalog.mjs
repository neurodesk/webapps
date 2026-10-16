import { createHash } from 'node:crypto';

export async function mockExampleIntegrity(page, files, body) {
  const sha256 = createHash('sha256').update(body).digest('hex');
  const urls = files.map(file => file.url);
  await page.waitForFunction(urls => {
    const available = new Set([...document.querySelectorAll('nd-example-selector')]
      .flatMap(selector => (selector.examples ?? []).flatMap(example => example.files.map(file => file.url))));
    return urls.every(url => available.has(url));
  }, urls);
  await page.evaluate(({ urls, sha256, bytes }) => {
    const selected = new Set(urls);
    for (const selector of document.querySelectorAll('nd-example-selector')) {
      if (!selector.examples.some(example => example.files.some(file => selected.has(file.url)))) continue;
      selector.examples = selector.examples.map(example => ({
        ...example,
        files: example.files.map(file => selected.has(file.url) ? { ...file, sha256, bytes } : file),
      }));
    }
  }, { urls, sha256, bytes: body.byteLength });
}
