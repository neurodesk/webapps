// Must be imported before onnxruntime-node so Linux builds do not write device telemetry to ~/.cache.
if (process.env.ORT_DISABLE_TELEMETRY === undefined) {
  process.env.ORT_DISABLE_TELEMETRY = "1";
}
