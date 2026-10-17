/**
 * Copy text to the clipboard. Tries the async Clipboard API first and falls
 * back to a hidden textarea + execCommand('copy') (e.g. insecure context,
 * unfocused page, or denied permission). Resolves to whether the copy worked;
 * never rejects.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path below.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
};
