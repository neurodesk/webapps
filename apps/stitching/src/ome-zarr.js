// The fused image as a zipped OME-Zarr (.ozx, OME-Zarr 0.5, one scale), written with
// ngff-zarr as apps/elastix does. Axes are z?, y, x; each axis whose pixel size the tiles record
// is in micrometres, any other in pixels with no unit (omeZarrCalibration in outputs.js).
import { NgffImage, itkImageToNgffImage, toMultiscales, toOmeZarrOzx } from "@fideus-labs/ngff-zarr/browser";
import { omeZarrCalibration } from "./outputs.js";

export async function writeFusedOmeZarr({ data, shape, pixelSize, dtype }, name) {
  const dimension = shape.length;
  const { spacing, units } = omeZarrCalibration(pixelSize, dimension);
  const image = await itkImageToNgffImage(
    {
      imageType: { dimension, componentType: dtype, pixelType: "Scalar", components: 1 },
      name: "fused",
      origin: new Array(dimension).fill(0),
      spacing,
      direction: Float64Array.from({ length: dimension * dimension }, (_, k) => (k % (dimension + 1) === 0 ? 1 : 0)),
      size: [...shape],
      metadata: new Map(),
      data,
    },
    { addAnatomicalOrientation: false },
  );
  const withUnits = new NgffImage({
    data: image.data,
    dims: image.dims,
    scale: image.scale,
    translation: image.translation,
    name: "fused",
    axesUnits: Object.keys(units).length ? units : undefined,
    axesOrientations: undefined,
    axesTypes: image.axesTypes,
    computedCallbacks: [],
  });
  const multiscales = await toMultiscales(withUnits, { scaleFactors: [] });
  delete multiscales.metadata.type;
  delete multiscales.metadata.metadata;
  const bytes = await toOmeZarrOzx(multiscales);
  return new File([bytes], name, { type: "application/zip" });
}
