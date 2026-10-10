// Session ownership stays in the scientific operation, including failed inference.
export function managedRuntime(ort, sessions) {
  return {
    Tensor: ort.Tensor,
    InferenceSession: {
      async create(bytes, options) {
        const session = await ort.InferenceSession.create(bytes, options);
        const owned = {
          inputNames: session.inputNames,
          outputNames: session.outputNames,
          async run(inputs) {
            let outputs;
            try {
              outputs = await session.run(inputs);
              return Object.fromEntries(
                await Promise.all(
                  Object.entries(outputs).map(async ([name, tensor]) => [
                    name,
                    { data: new Float32Array(await tensor.getData()) },
                  ])
                )
              );
            } finally {
              for (const tensor of Object.values(inputs)) tensor.dispose();
              for (const tensor of Object.values(outputs || {})) tensor.dispose();
            }
          },
          async release() {
            if (!sessions.delete(owned)) return;
            await session.release();
          },
        };
        sessions.add(owned);
        return owned;
      },
    },
  };
}
