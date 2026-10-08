import { escapeHtml } from './escapeHtml.js';

describe('escapeHtml', () => {
  test('escapes markup and both quote styles', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`))
      .toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
  });

  test('leaves ordinary file names unchanged', () => {
    expect(escapeHtml('sub-01_echo-1_part-phase_MEGRE.nii.gz')).toBe('sub-01_echo-1_part-phase_MEGRE.nii.gz');
  });

  test('stringifies non-string values', () => {
    expect(escapeHtml(3)).toBe('3');
    expect(escapeHtml(null)).toBe('null');
  });
});
