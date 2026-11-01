// Acceptance of a completed browser experiment, separate from its memory measurements.
export function browserResultProblems(result, nativeMatSha256) {
  const problems = [];
  if (result.mode === "full") {
    if (result.reply?.error !== null || result.reply?.id !== 1) problems.push("SyN worker did not return a successful reply");
    for (const file of ["fmap_syn0Warp.nii.gz", "fmap_syn0InverseWarp.nii.gz"]) {
      const output = result.reply?.outputs?.[file];
      const comparison = result.outputs_vs_replay?.[file];
      if (!Number.isSafeInteger(output?.bytes) || output.bytes <= 0) problems.push(`missing or empty output: ${file}`);
      if (comparison?.bytes_equal !== true || comparison?.decompressed_equal !== true || comparison?.uploaded_sha256_matches_page !== true) {
        problems.push(`output differs from replay or upload: ${file}`);
      }
    }
    if (!result.linear_memory?.memories?.length) problems.push("worker linear-memory observation is missing");
  } else if (result.mode === "cancel") {
    if (!(result.before_terminate?.after_s > 0)) problems.push("worker was not observed running before cancellation");
    if (result.reply_after_terminate !== "no reply (terminated)") problems.push("cancelled worker sent a reply");
    const rigid = result.rigid_after_terminate;
    if (rigid?.error !== null || rigid?.native_bytes !== true || rigid?.sha256 !== nativeMatSha256) {
      problems.push("fresh worker did not recover the native rigid output");
    }
  } else problems.push("unknown browser experiment mode");
  if (!result.after_terminate?.length) problems.push("post-termination observations are missing");
  return problems;
}
