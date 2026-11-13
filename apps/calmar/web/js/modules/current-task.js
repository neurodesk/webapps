// Owned workflows yield asynchronous preparation. Only this runner resumes
// them, checking ownership before success, catch or further work can execute.
// A superseded workflow is abandoned, including its catch/finally blocks;
// resource cleanup belongs in the preparation promise or onSettled.
// onSettled runs outside the ownership gate and must release only owned resources.
export async function runCurrent(assertCurrent, workflow, { stopWhenSuperseded = false, onSettled } = {}) {
  const resume = (method, value) => {
    try {
      assertCurrent();
    } catch (error) {
      if (stopWhenSuperseded && error.name === 'AbortError') return { done: true };
      throw error;
    }
    return workflow[method](value);
  };
  let failure;
  try {
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
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    onSettled?.(failure);
  }
}
