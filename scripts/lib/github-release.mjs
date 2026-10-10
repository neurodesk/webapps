export function readDraftRelease(gh, tag) {
  let output;
  try {
    output = gh(['release', 'view', tag, '--json', 'isDraft']);
  } catch (error) {
    // GitHub CLI reports an absent release separately from authentication/network failures.
    if (/release not found/i.test(String(error.stderr ?? ''))) return null;
    throw error;
  }
  return JSON.parse(output);
}
