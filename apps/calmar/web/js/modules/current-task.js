// Owned workflows yield asynchronous preparation. Only this runner resumes
// them, checking ownership before success, catch or further work can execute.
// A superseded workflow is abandoned, including its catch/finally blocks;
// resource cleanup belongs in the preparation promise itself.
export async function runCurrent(assertCurrent, workflow, { stopWhenSuperseded = false } = {}) {
  const resume = (method, value) => {
    try {
      assertCurrent();
    } catch (error) {
      if (stopWhenSuperseded && error.name === 'AbortError') return { done: true };
      throw error;
    }
    return workflow[method](value);
  };
  let step = resume('next');
  while (!step.done) {
    let value;
    let failed = false;
    try {
      value = await step.value;
    } catch (error) {
      failed = true;
      value = error;
    }
    step = resume(failed ? 'throw' : 'next', value);
  }
  return step.value;
}
