// Point every ITK-Wasm package at the pipelines staged by scripts/copy-pipelines.mjs.
// Imported first: a pipeline call before this would fetch from the jsDelivr default.
import { setPipelinesBaseUrl as setElastixBaseUrl } from "@itk-wasm/elastix";
import { setPipelinesBaseUrl as setImageIoBaseUrl } from "@itk-wasm/image-io";
import { setPipelinesBaseUrl as setTransformIoBaseUrl } from "@itk-wasm/transform-io";

const pipelinesBaseUrl = new URL(`${import.meta.env.BASE_URL}pipelines`, document.baseURI).href;
setElastixBaseUrl(pipelinesBaseUrl);
setImageIoBaseUrl(pipelinesBaseUrl);
setTransformIoBaseUrl(pipelinesBaseUrl);
