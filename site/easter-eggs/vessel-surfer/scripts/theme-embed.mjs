import { cp, readFile, writeFile, rm } from "node:fs/promises";
const site = new URL("../../../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
for (const name of ["app-theme.css", "theme.js"])
  await cp(new URL(name, site), new URL(name, dist));
const index = new URL("index.html", dist);
let html = await readFile(index, "utf8");
html = html.replace(
  '<html lang="en">',
  '<html lang="en" data-neurodesk-app="vessel-surfer" data-neurodesk-shell="imaging-workspace" data-neurodesk-theme="dark">',
);
html = html.replace(
  "</head>",
  '<link rel="stylesheet" href="./app-theme.css"><script src="./theme.js" defer data-neurodesk-theme-controller></script></head>',
);
await writeFile(index, html);

await rm(new URL("data/ixi322-vessels.nii.gz", dist), { force: true });
