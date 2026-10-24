/** SHA-256 of file bytes, with cancellation checked around the digest. */
export async function sha256(bytes, signal) {
  signal?.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  signal?.throwIfAborted();
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
