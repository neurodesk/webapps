// The steps the web app and the command line share around an elastix run:
// the image elastix registers and the TransformParameters files it leaves.
// ITK-Wasm pipeline calls are injected, so each runtime supplies its own
// (a web worker in the browser, the Node runner on the command line).
import { castImage, FloatTypes } from "itk-wasm";
import { chainParameterFiles } from "./parameter-maps.js";
import { squeezeSingletons } from "./sources.js";

/**
 * An uncaught C++ exception in the elastix module rejects with a bare number
 * (a pointer); say what usually causes it instead of showing that number.
 */
export function registrationError(error) {
  if (typeof error === "number") {
    return new Error("elastix stopped with an internal error. Check that both images overlap and hold one scalar channel.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The scalar 2D/3D image as read (`scalar`) and the float32 copy elastix
 * registers (`image`). elastix dispatches on the stationary image's pixel type
 * and casts its result back to it, which would wrap B-spline overshoot in an
 * integer type; float32 inputs register any pair of pixel types.
 */
export function registrationImage(image) {
  const scalar = squeezeSingletons(image);
  const float = scalar.imageType.componentType === FloatTypes.Float32
    ? scalar
    : castImage(scalar, { componentType: FloatTypes.Float32 });
  return { scalar, image: float };
}

/**
 * The run's TransformParameters files as `{ name, data }` TOML text, chained
 * through InitialTransformParameterFileName so transformix given the last one
 * applies every stage. `writeParameterFiles(maps, names)` is ITK-Wasm's
 * writer, which picks TOML from the `.toml` names.
 */
export async function transformParameterFiles(transformParameterObject, stem, writeParameterFiles) {
  const { maps, names } = chainParameterFiles(transformParameterObject, stem);
  const { parameterFiles } = await writeParameterFiles(maps, names);
  if (parameterFiles.length !== names.length || parameterFiles.some((file) => !file?.data)) {
    throw new Error("elastix wrote an empty parameter file.");
  }
  return parameterFiles.map((file, index) => ({ name: names[index], data: file.data }));
}
