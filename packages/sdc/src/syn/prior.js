// SPDX-License-Identifier: Apache-2.0
// The SHA-256 of the prior files (sdc/prior/ on the Hugging Face dataset), as models/sdc.manifest.json pins them.
export const PRIOR_SHA256 = Object.freeze({
  'fmap_atlas.nii.gz': '72b8d2cc7ff3324f3bfaf52712bc191256e795bcff5ee168563b89e584aa40bb',
  'fmap_atlas_2_MNI152NLin2009cAsym_affine.mat': '588820bdaefab4f98c42b3a394c7c975ad9764bc5d8b095718f47419a9ea6ffc',
  'tpl-MNI152NLin2009cAsym_res-01_T1w.nii.gz': '1f27aabea9f7183dc0c69dafa71e1787b921ca778d655d9c1bf302b273d5627a',
  'tpl-MNI152NLin2009cAsym_res-01_desc-brain_mask.nii.gz': 'e40bb1816736504d4c25abc243c1c8503df1d308f64c048318aa4b829e09a7ae',
});

/** Where the command line downloads the prior from: sdc/prior/ at the commit models/sdc.manifest.json pins. */
export const PRIOR_BASE_URL = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/4c6c9e8efd8a1f4d110501f6fe30a10029bec570/sdc/prior/';

/** The notices that travel with the prior files (exes/dwi/sdc/validation/prior.manifest.json). */
export const PRIOR_NOTICES_SHA256 = Object.freeze({
  'README.md': '231d452c42cd20239e23316604ad2db036e8785fe989c334d56eb91232bc23a6',
  'LICENSE-sdcflows': 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  'LICENSE-MNI152NLin2009cAsym': '46e280fe1a24c6f37feef2445ed288435e0ad063504a06030b206b12fdd2629d',
});
