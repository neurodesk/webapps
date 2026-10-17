// DOM-independent app logic, unit-tested under Node (test/config.test.js).
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "fastprep",
  version: packageJson.version,
});

const DATATYPE = {
  anat: ["T1w", "T2w", "FLAIR", "T1wRMS", "UNIT1", "MP2RAGE", "PDw", "T2starw"],
  func: ["bold", "sbref", "events", "physio"],
  fmap: ["phasediff", "magnitude", "magnitude1", "magnitude2", "phase1", "phase2", "fieldmap", "epi"],
};

/** BIDS path of a loose file from its name: sub/ses entities and the suffix's datatype. */
export function bidsPath(name) {
  const stem = name.split(".")[0];
  const sub = stem.match(/(?:^|_)(sub-[^_]+)/)?.[1];
  if (!sub) return name; // dataset-level files (dataset_description.json, task sidecars)
  const ses = stem.match(/_(ses-[^_]+)/)?.[1];
  const suffix = stem.split("_").at(-1);
  const datatype = Object.keys(DATATYPE).find((d) => DATATYPE[d].includes(suffix));
  return [sub, ses, datatype, name].filter(Boolean).join("/");
}

/** Paths relative to the BIDS root: a chosen dataset folder's own name is dropped; loose files are placed by name. */
export function datasetPaths(paths) {
  const first = paths.map((p) => p.split("/"));
  const top = first[0]?.[0];
  const wrapped = top && !top.startsWith("sub-") && first.every((parts) => parts.length > 1 && parts[0] === top);
  return first.map((parts) => (parts.length === 1 ? bidsPath(parts[0]) : (wrapped ? parts.slice(1) : parts).join("/")));
}

/** The report with its figure, map and page links pointing at in-memory copies (blob URLs). Pages link to each
 * other (subject report <-> task page); a link back to a page still being built can have no blob URL yet, so it
 * goes back in the frame's history, which is how that page was reached. */
export function reportWithLinks(page, outputs, toUrl, done = new Map()) {
  const files = new Map(outputs);
  done.set(page, null); // building
  const link = (rel) => {
    if (!files.has(rel)) return rel;
    if (done.get(rel) === null) return "javascript:history.back()";
    if (!done.has(rel)) {
      done.set(rel, rel.endsWith(".html")
        ? toUrl(reportWithLinks(rel, outputs, toUrl, done), "text/html")
        : toUrl(files.get(rel), rel.endsWith(".png") ? "image/png" : "application/octet-stream"));
    }
    return done.get(rel);
  };
  const html = new TextDecoder().decode(files.get(page));
  return html.replace(/(src|href)="([^"#:]+)"/g, (_m, attr, rel) => `${attr}="${link(rel)}"`);
}
