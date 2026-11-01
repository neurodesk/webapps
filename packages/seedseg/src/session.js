export async function runWithFallback({ backend, createSession, execute, onFallback }) {
  for (const provider of backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm']) {
    let session;
    let result;
    try {
      session = await createSession(provider);
      result = await execute(session);
    } catch (error) {
      try {
        await session?.release();
      } catch {
        // Failed-session cleanup must preserve the inference error and its fallback.
      }
      if (provider !== 'webgpu') throw error;
      onFallback(error);
      continue;
    }
    await session.release();
    return { result, backend: provider };
  }
}
