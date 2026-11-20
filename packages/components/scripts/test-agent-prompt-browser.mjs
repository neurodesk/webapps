import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { serveSite } from '../../../test-utils/serve-site.mjs';

// The agent's consent dialogs in Chromium, driven by the keyboard and pointer: every way of closing one
// is a Decline, before and after the dialog refreshes, and no key or press inside it counts as the
// person using the page (webmcp/tool-inputs.js interactionEffect), which would cancel the agent's call
// instead of declining it.
const fixture = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Agent prompt browser verification</title>
  <link rel="stylesheet" href="/src/styles/imaging-workspace.css">
</head>
<body>
  <main><p>Workspace</p><button id="pageButton" type="button">Page control</button></main>
  <script type="module">
    import { createAgentPrompts } from '/src/ui/agentPrompt.js';
    import { interactionEffect } from '/src/webmcp/tool-inputs.js';

    const states = {
      confirmFetch: [
        { app: 'ZARRo', addresses: ['https://data.test/first.ome.zarr'], readsUnder: true },
        { app: 'ZARRo', addresses: ['https://data.test/second.ome.zarr'], readsUnder: true },
      ],
      confirmFiles: [
        { app: 'NiiMath', label: 'Image', files: [{ name: 'first.nii.gz', bytes: 4 }] },
        { app: 'NiiMath', label: 'Image', files: [{ name: 'second.nii.gz', bytes: 4 }] },
      ],
      confirmResume: [
        { app: 'NiiMath', files: [{ role: 'image', name: 'first.nii.gz' }], run: null },
        { app: 'NiiMath', files: [{ role: 'image', name: 'second.nii.gz' }], run: null },
      ],
    };
    const prompts = createAgentPrompts();
    const fixture = window.fixture = { counted: [], answer: undefined, state: 0 };
    for (const type of ['keydown', 'pointerdown', 'pointerup']) {
      window.addEventListener(type, event => {
        const effect = interactionEffect(event, document);
        if (effect) fixture.counted.push(type + ':' + (event.key ?? '') + ':' + effect);
      }, true);
    }
    fixture.open = name => {
      fixture.state = 0;
      fixture.answer = undefined;
      fixture.counted = [];
      prompts[name](() => states[name][fixture.state]).then(answer => { fixture.answer = answer; });
    };
    fixture.change = () => { fixture.state = 1; };
    fixture.ready = true;
  </script>
</body>
</html>`;

const site = await serveSite(fileURLToPath(new URL('..', import.meta.url)));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${site.origin}/`, route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto(site.origin);
  await page.waitForFunction(() => window.fixture?.ready);

  const dialog = page.locator('#neurodeskAgentPrompt');
  const allow = dialog.getByRole('button', { name: 'Allow', exact: true });
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? null);
  const settled = async () => {
    await page.waitForFunction(() => window.fixture.answer !== undefined);
    return page.evaluate(() => ({ answer: window.fixture.answer, counted: window.fixture.counted, open: document.getElementById('neurodeskAgentPrompt').open }));
  };
  async function open(name) {
    await page.evaluate(prompt => window.fixture.open(prompt), name);
    await allow.waitFor({ state: 'visible' });
  }
  // The person presses Allow from the keyboard after the request changed: the dialog shows the new request in place.
  async function refresh(name) {
    await allow.focus();
    await page.evaluate(() => window.fixture.change());
    await page.keyboard.press('Enter');
    await dialog.getByText('This changed since it was shown. Check it again.').waitFor();
    assert.equal(await focused(), 'Allow', `${name}: Allow keeps the focus when the dialog refreshes`);
    assert.equal(await dialog.locator('.nd-message.warning').count(), 1, `${name}: one notice that the request changed`);
    assert.ok((await dialog.textContent()).includes('second'), `${name}: the refreshed dialog names the new request`);
    assert.ok(!(await dialog.textContent()).includes('first'), `${name}: the refreshed dialog no longer names the old request`);
  }
  const declined = (name, how, result) => {
    assert.equal(result.answer, null, `${name}: ${how} declines`);
    assert.equal(result.open, false, `${name}: ${how} closes the dialog`);
    assert.deepEqual(result.counted, [], `${name}: ${how} is not the person using the page`);
  };

  for (const name of ['confirmFetch', 'confirmFiles', 'confirmResume']) {
    for (const refreshed of [false, true]) {
      const when = refreshed ? 'after a refresh' : 'before a refresh';

      await open(name);
      if (refreshed) await refresh(name);
      await page.keyboard.press('Escape');
      declined(name, `Escape ${when}`, await settled());

      await open(name);
      if (refreshed) await refresh(name);
      await dialog.locator('.nd-dialog-body p').last().click();
      await page.keyboard.press('Escape');
      declined(name, `Escape after a press on the dialog's text ${when}`, await settled());

      await open(name);
      if (refreshed) await refresh(name);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      declined(name, `the close control ${when}`, await settled());

      await open(name);
      if (refreshed) await refresh(name);
      await page.mouse.click(4, 4);
      declined(name, `a press on the backdrop ${when}`, await settled());

      await open(name);
      if (refreshed) await refresh(name);
      await dialog.getByRole('button', { name: 'Decline', exact: true }).focus();
      await page.keyboard.press('Enter');
      declined(name, `Decline from the keyboard ${when}`, await settled());

      await open(name);
      if (refreshed) await refresh(name);
      await allow.focus();
      await page.keyboard.press('Enter');
      const allowed = await settled();
      assert.deepEqual(allowed.counted, [], `${name}: Allow ${when} is not the person using the page`);
      assert.ok(allowed.answer, `${name}: Allow ${when} resolves to the request`);
      assert.ok(JSON.stringify(allowed.answer).includes(refreshed ? 'second' : 'first'), `${name}: Allow ${when} resolves to the request it showed`);
    }
  }
  assert.deepEqual(errors, []);
  console.log('Agent prompt browser checks passed');
} finally {
  await browser?.close();
  await site.close();
}
