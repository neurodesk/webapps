/**
 * Copy text to the clipboard. Tries the async Clipboard API first and falls
 * back to a hidden textarea + execCommand('copy') (e.g. insecure context,
 * unfocused page, or denied permission). Rejects if both methods fail so the
 * caller's asyncCallback reports the error in the status bar and technical log.
 */
export const copyText = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to the legacy path below.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand('copy')) {
      throw new Error('Could not copy to clipboard. Check browser permissions and try again.');
    }
  } finally {
    document.body.removeChild(textarea);
  }
};
