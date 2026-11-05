// The fused image as a zipped OME-Zarr (.ozx, OME-Zarr 0.5, one scale), written with
// ngff-zarr as apps/elastix does. Axes are z?, y, x in micrometres when the tiles record a
// pixel size, else in pixels with no unit.
import { NgffImage, itkImageToNgffImage, toMultiscales, toOmeZarrOzx } from "@fideus-labs/ngff-zarr/browser";

export async function writeFusedOmeZarr({ data, shape, pixelSize, dtype }, name) {
  const dimension = shape.length;
  const spacing = shape.map((_, d) => [pixelSize?.x, pixelSize?.y, pixelSize?.z][d] || 1);
  const micrometres = Boolean(pixelSize?.x && pixelSize?.y && (dimension < 3 || pixelSize?.z));
  const image = await itkImageToNgffImage(
    {
      imageType: { dimension, componentType: dtype, pixelType: "Scalar", components: 1 },
      name: "fused",
      origin: new Array(dimension).fill(0),
      spacing: micrometres ? spacing : new Array(dimension).fill(1),
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
    axesUnits: micrometres ? Object.fromEntries(image.dims.map((axis) => [axis, "micrometer"])) : undefined,
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
