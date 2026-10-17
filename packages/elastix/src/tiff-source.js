import { TiffStore } from "@fideus-labs/fiff";
import { DOMParser } from "@xmldom/xmldom";
import { fromArrayBuffer, fromBlob, fromUrl } from "geotiff";

async function withProvenance(tiff) {
  const store = await TiffStore.fromGeoTIFF(tiff);
  const pixels = store.ome[0]?.pixels;
  const physicalSizes = Object.fromEntries(["X", "Y", "Z"].map((axis) => [axis.toLowerCase(), pixels?.[`physicalSize${axis}`]]));
  let hasPlanePositions = false;
  if (pixels) {
    const first = await tiff.getImage(0);
    const xml = await first.fileDirectory.loadValue("ImageDescription");
    const document = new DOMParser().parseFromString(xml, "application/xml");
    // fiff exposes physical sizes, but drops Plane positions when synthesizing NGFF.
    hasPlanePositions = Array.from(document.getElementsByTagNameNS("*", "Plane"))
      .some((plane) => ["X", "Y", "Z"].some((axis) => plane.hasAttribute(`Position${axis}`)));
  }
  return { get: store.get.bind(store), tiffMetadata: { physicalSizes, hasPlanePositions } };
}

export const TiffSource = {
  fromArrayBuffer: async (buffer) => withProvenance(await fromArrayBuffer(buffer)),
  fromBlob: async (blob) => withProvenance(await fromBlob(blob)),
  fromUrl: async (url) => withProvenance(await fromUrl(url)),
};
