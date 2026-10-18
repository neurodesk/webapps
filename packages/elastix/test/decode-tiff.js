import { fromArrayBuffer } from "geotiff";
import { DOMParser } from "@xmldom/xmldom";

export async function decodeTiff(bytes) {
  const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).getImage();
  const document = new DOMParser().parseFromString(await image.fileDirectory.loadValue("ImageDescription"), "application/xml");
  const pixels = document.getElementsByTagNameNS("http://www.openmicroscopy.org/Schemas/OME/2016-06", "Pixels")[0];
  const [data] = await image.readRasters();
  return {
    data,
    spacing: ["X", "Y"].map((axis) => Number(pixels.getAttribute(`PhysicalSize${axis}`))),
    units: ["X", "Y"].map((axis) => pixels.getAttribute(`PhysicalSize${axis}Unit`)),
  };
}
