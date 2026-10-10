import { JSDOM } from 'jsdom';

// Record upstream DOI links without importing its application-owned dialog.
export function upstreamCitationSnapshot(html, commit, selector) {
  const document = new JSDOM(html).window.document;
  const block = document.querySelector(selector);
  if (!block) throw new Error(`Upstream citation block missing: ${selector}`);
  const dois = [...block.querySelectorAll('a[href]')]
    .map(link => link.getAttribute('href').match(/^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i)?.[1])
    .filter(Boolean)
    .map(doi => decodeURIComponent(doi).toLowerCase());
  if (!dois.length) throw new Error(`Upstream citation block has no DOI links: ${selector}`);
  return { commit, dois: [...new Set(dois)].sort() };
}
