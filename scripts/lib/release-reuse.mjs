// A suite release carries gigabytes per platform and the model pack rarely
// changes, so an archive whose bytes are already published is referenced where
// it lies instead of being uploaded again.

export function archiveHash(record) {
  return record.archiveSha256 || record.sha256;
}

export function recordUrls(record) {
  return [record.url, ...(record.parts || []).map(part => part.url)];
}

// The published record is kept whole. Its install notes name its own part
// filenames, so pairing fresh notes with reused URLs would hand a user a
// reassembly command for files that were never published under those names.
export function reuseCandidate(previous, record) {
  const published = [...(previous?.downloads || []), ...(previous?.models ? [previous.models] : [])];
  const match = published.find(item => item.platform === record.platform && item.kind === record.kind && archiveHash(item) === archiveHash(record));
  return match && recordUrls(match).every(url => typeof url === 'string' && url.length) ? match : null;
}

export function reusePlan(previous, records) {
  return records.map(record => ({ record, candidate: reuseCandidate(previous, record) }));
}
