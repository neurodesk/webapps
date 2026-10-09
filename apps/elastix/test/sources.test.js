import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCompatiblePair, chooseLevel, classifySource, squeezeSingletons, urlName, voxelCount, zarrFolderEntries } from "../src/sources.js";

const file = (name, path = "") => ({ name, _webkitRelativePath: path });

test("local files are routed to the reader their format needs", () => {
  assert.equal(classifySource([file("t1.nii.gz")]), "nifti");
  assert.equal(classifySource([file("t1.nii")]), "nifti");
  assert.equal(classifySource([file("IM0001"), file("IM0002")]), "dicom");
  assert.equal(classifySource([file("slice.dcm")]), "dicom");
  assert.equal(classifySource([file("ct.nrrd")]), "itk");
  assert.equal(classifySource([file("ct.mha")]), "itk");
  assert.equal(classifySource([file("brain.mgz")]), "itk");
  assert.equal(classifySource([file("plane.tif")]), "tiff");
  assert.equal(classifySource([file("stack.ome.tiff")]), "tiff");
  assert.equal(classifySource([file("image.ome.zarr.ozx")]), "ozx");
  assert.equal(classifySource([file("zarr.json", "drop/image.ome.zarr/zarr.json"), file("0", "drop/image.ome.zarr/0/c/0/0")]), "zarr-folder");
  assert.throws(() => classifySource([]), /Choose an image/);
});

test("detached ITK headers are refused with self-contained conversion guidance", () => {
  for (const extension of ["mhd", "nhdr", "MHD", "NHDR"]) {
    const header = file(`image.${extension}`);
    for (const selection of [[header], [header, file("image.raw")], [file("image.raw"), header]]) {
      assert.throws(() => classifySource(selection), /detached header.*self-contained \.mha or \.nrrd.*NIfTI/);
    }
    assert.throws(() => classifySource(`https://example.org/image.${extension}?download=1`), /detached header.*self-contained \.mha or \.nrrd.*NIfTI/);
  }
});

test("URLs are routed by their path, ignoring queries and trailing slashes", () => {
  assert.equal(classifySource("https://example.org/data/image.ome.zarr/"), "zarr-url");
  assert.equal(classifySource("https://example.org/idr0051/preview.zarr/0"), "zarr-url");
  assert.equal(classifySource("https://example.org/plane.ome.tif?download=1"), "tiff-url");
  assert.equal(classifySource("https://example.org/image.ozx"), "ozx-url");
  assert.equal(classifySource("https://example.org/t1.nii.gz"), "file-url");
  assert.equal(urlName("https://example.org/idr0051/preview.zarr/0"), "preview.zarr");
  assert.equal(urlName("https://example.org/a/plane%201.tif"), "plane 1.tif");
});

test("a dropped .zarr folder is keyed by path below its root", () => {
  const { root, entries } = zarrFolderEntries([
    file("zarr.json", "drop/image.zarr/zarr.json"),
    file("0", "drop/image.zarr/0/c/0/0"),
    file("notes.txt", "drop/notes.txt"),
  ]);
  assert.equal(root, "drop/image.zarr/");
  assert.deepEqual([...entries.keys()], ["zarr.json", "0/c/0/0"]);
  assert.throws(() => zarrFolderEntries([file("notes.txt", "drop/notes.txt")]), /\.zarr/);
});

const level = (shape, dims = ["z", "y", "x"]) => ({ dims, data: { shape } });

test("the finest pyramid level within the voxel budget is registered", () => {
  const images = [level([400, 2048, 2048]), level([200, 1024, 1024]), level([100, 512, 512])];
  assert.equal(chooseLevel(images, 2 ** 28).level, 1);
  assert.equal(chooseLevel(images, 2 ** 40).level, 0);
  assert.equal(chooseLevel(images, 10).level, 2);
  // Time and channel axes do not count against the spatial budget.
  assert.equal(chooseLevel([level([50, 3, 100, 100], ["t", "c", "y", "x"])], 10_000).level, 0);
});

function image({ size, components = 1, direction }) {
  const dimension = size.length;
  return {
    name: "test",
    imageType: { dimension, components, componentType: "uint16", pixelType: "Scalar" },
    size,
    spacing: size.map(() => 0.5),
    origin: size.map(() => 1),
    direction: direction ?? new Float64Array(dimension * dimension).map((_, index) => (index % (dimension + 1) === 0 ? 1 : 0)),
    data: new Uint16Array(size.reduce((a, b) => a * b, 1)),
  };
}

test("an image's voxel count spans every axis", () => {
  assert.equal(voxelCount(image({ size: [64, 32, 10] })), 20_480);
  assert.equal(voxelCount(image({ size: [128, 128] })), 16_384);
});

test("a single-slice volume becomes a 2D image", () => {
  const squeezed = squeezeSingletons(image({ size: [64, 32, 1], direction: new Float64Array([0, 1, 0, -1, 0, 0, 0, 0, 1]) }));
  assert.equal(squeezed.imageType.dimension, 2);
  assert.deepEqual(squeezed.size, [64, 32]);
  assert.deepEqual(squeezed.spacing, [0.5, 0.5]);
  assert.deepEqual(Array.from(squeezed.direction), [0, 1, -1, 0]);
  const volume = image({ size: [8, 8, 8] });
  assert.equal(squeezeSingletons(volume), volume);
});

test("single-slice sagittal and oblique volumes are refused before their geometry is projected", () => {
  const angle = Math.PI / 6;
  const directions = [
    [0, 0, 1, 0, 1, 0, -1, 0, 0],
    [1, 0, 0, 0, 0, -1, 0, 1, 0],
    [1, 0, 0, 0, Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle)],
  ];
  for (const direction of directions) {
    const plane = image({ size: [64, 32, 1], direction: new Float64Array(direction) });
    assert.throws(() => squeezeSingletons(plane), /single-slice 3D image with an oblique or non-axial plane/);
    assert.deepEqual(Array.from(plane.direction), direction);
    assert.equal(plane.imageType.dimension, 3);
  }
});

test("color, 1D and 4D images are refused", () => {
  assert.throws(() => squeezeSingletons(image({ size: [8, 8], components: 3 })), /3 components/);
  assert.throws(() => squeezeSingletons(image({ size: [8, 8, 8, 2] })), /4 dimensions/);
  assert.throws(() => squeezeSingletons(image({ size: [8] })), /1 dimensions/);
});

test("a 2D and a 3D image cannot be registered together", () => {
  assert.doesNotThrow(() => assertCompatiblePair(image({ size: [8, 8] }), image({ size: [4, 4] })));
  assert.throws(() => assertCompatiblePair(image({ size: [8, 8, 8] }), image({ size: [8, 8] })), /moving image is 2D and the stationary image is 3D/);
});
