// Playwright reporter that prints each test's duration, slowest first, and
// calls out tests that only passed on retry. CI adds it to every app's own
// reporters through PW_TEST_REPORTER, so the e2e logs show both slow tests
// worth tagging @slow and flaky tests that passed on retry.
export default class TestDurationsReporter {
  #results = [];
  #flaky = [];

  printsToStdio() {
    return false;
  }

  onTestEnd(test, result) {
    const title = test.titlePath().filter(Boolean).slice(1).join(' › ');
    const entry = {
      title,
      tags: test.tags.join(' '),
      status: result.status,
      retry: result.retry ?? 0,
      seconds: result.duration / 1000,
    };
    this.#results.push(entry);
    if (result.status === 'passed' && (result.retry ?? 0) > 0) {
      this.#flaky.push(entry);
    }
  }

  onEnd() {
    if (!this.#results.length) return;
    const total = this.#results.reduce((sum, { seconds }) => sum + seconds, 0);
    const lines = this.#results
      .sort((a, b) => b.seconds - a.seconds)
      .map(({ title, tags, status, retry, seconds }) => {
        const label = retry > 0 ? `${status}#${retry}` : status;
        return `${seconds.toFixed(1).padStart(8)}s  ${label.padEnd(10)}  ${title}${tags ? `  ${tags}` : ''}`;
      });
    console.log(`\nTest durations (${total.toFixed(0)} s in ${this.#results.length} attempts):\n${lines.join('\n')}`);
    if (this.#flaky.length) {
      console.log(`\nFlaky tests (${this.#flaky.length} passed on retry):`);
      for (const { title, retry, seconds } of this.#flaky) {
        console.log(`::warning title=Flaky Playwright test::${title} passed on retry #${retry} (${seconds.toFixed(1)}s)`);
      }
    }
  }
}
