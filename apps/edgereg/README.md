# EdgeReg

EdgeReg registers a moving NIfTI or DICOM image to a stationary image entirely in the browser. It uses NiiVue for viewing, dcm2niix for DICOM conversion, and niimath `-allineate` for affine registration.

## Example data

Example images live in the `neurodeskorg/webapps` Hugging Face dataset under `reg/templates` and `reg/moving`. Authenticate and upload a prepared local tree with:

```bash
hf auth login
hf upload neurodeskorg/webapps ./reg reg --repo-type dataset
```

From the webapps repository root, prepare the same files offered by the standalone EdgeReg. Set `EDGEREG_SOURCE` if its checkout is not the adjacent `../EdgeReg` directory:

```bash
mkdir -p reg/templates reg/moving
EDGEREG_SOURCE=${EDGEREG_SOURCE:-../EdgeReg}
cp "$EDGEREG_SOURCE"/public/{MNI152_T1_1mm,avg152T1,MNI152_T1_ext}.nii.gz reg/templates/
cp "$EDGEREG_SOURCE"/public/t1_crop.nii.gz reg/moving/
base=https://raw.githubusercontent.com/niivue/niivue-demo-images/main
for path in CT_Philips.nii.gz fmri_pitch.nii.gz pcasl.nii.gz chris_t2.nii.gz chris_PD.nii.gz register/T1_head.nii.gz register/fmri.nii.gz register/T1_head_ext.nii.gz register/T2w.nii.gz register/FLAIR_2D.nii.gz register/T1_ds000031.nii.gz register/dwi.nii.gz; do
  curl -fL "$base/$path" -o "reg/moving/${path##*/}"
done
hf auth login
hf upload neurodeskorg/webapps ./reg reg --repo-type dataset
```

The app pins dataset revision `67c378c8f8ac5313e5dbeee4c8d95ebe2a2f79c9` so releases remain reproducible.
