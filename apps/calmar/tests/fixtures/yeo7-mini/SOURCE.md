# Yeo 7-network atlas — committed copy

`atlas.nii.gz` is the **Yeo 7-network LiberalMask** parcellation at MNI152
2 mm resolution, dims `99 × 117 × 95` int16. Same file the deployed app
fetches at runtime from the Hugging Face dataset
[`sbollmann/lnm-webapp-models`](https://huggingface.co/datasets/sbollmann/lnm-webapp-models)
under the `atlasAssets[id="yeo7-2mm"]` manifest entry.

This copy lives in the repo so Node integration tests can compute Yeo
overlaps without a network round-trip. Identical bytes to the runtime
asset; if the runtime asset ever changes (different `cacheKey`), update
this copy too.

## Citation

Yeo BTT, Krienen FM, Sepulcre J, et al. The organization of the human
cerebral cortex estimated by intrinsic functional connectivity. Journal
of Neurophysiology. 2011;106(3):1125-65.

License: CC-BY (atlas labels in the original release are publicly
distributable for research purposes).

Network labels (label index → name):
- 1 → Visual
- 2 → Somatomotor
- 3 → DorsalAttention
- 4 → VentralAttention
- 5 → Limbic
- 6 → Frontoparietal
- 7 → Default

## Rebuild

```sh
# from a checkout with HF assets fetched into web/models/_dev_cache/:
cp web/models/_dev_cache/Yeo7_LiberalMask_2mm.nii.gz \
   tests/fixtures/yeo7-mini/atlas.nii.gz
```

Or refetch from the Hugging Face dataset URL listed in
`web/models/manifest.json` under `atlasAssets[id="yeo7-2mm"].sourceUrl`.
