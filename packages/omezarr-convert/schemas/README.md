# OME-NGFF JSON schemas

Copied unchanged from [ome/ngff](https://github.com/ome/ngff) at tag `0.5.2`
(commit `5cdf83b6806b5e500477c7af69dae9ed2adcf77d`):

| File | Source path |
| --- | --- |
| `0.4/image.schema`, `0.4/strict_image.schema` | `0.4/schemas/` |
| `0.5/_version.schema`, `0.5/image.schema`, `0.5/strict_image.schema` | `0.5/schemas/` |

Licence: W3C Software and Document License, as ome/ngff's `LICENSE.md` states for its
reports. `validation/checks.mjs` loads them with Ajv (draft 2020-12) and checks every
conversion in the tests against the strict image schema of its version.
