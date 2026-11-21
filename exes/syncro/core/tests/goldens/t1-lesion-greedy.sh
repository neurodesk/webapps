synthsr work/primary.nii work/t1.nii --threads 4 --force
BC_NUM_THREADS=4 brainchop-mindgrab work/t1.nii -o work/brain.nii --mask work/mask.nii
greedy-rs -threads 4 -d 3 -a -m NMI -i work/template.nii work/brain-f32.nii -o work/affine.mat -n 100x50x10 -ia-image-centers
greedy-rs -threads 4 -d 3 -m NMI -i work/template.nii work/brain-f32.nii -it work/affine.mat -o work/warp.nii -sv -n 100x50x10
greedy-rs -threads 4 -d 3 -rf work/template.nii -rm work/brain-f32.nii wbt1sub-01_T1w.nii.gz -r work/warp.nii work/affine.mat
greedy-rs -threads 4 -d 3 -rf work/template.nii -rm work/primary.nii wsub-01_T1w.nii.gz -r work/warp.nii work/affine.mat
FSLOUTPUTTYPE=NIFTI OMP_NUM_THREADS=4 niimath work/lesion.nii -s 1.2739827004487725 work/lesion-smoothed.nii -odt float
greedy-rs -threads 4 -d 3 -rf work/template.nii -rm work/lesion-smoothed.nii work/lesion-warped.nii -ri NN -r work/warp.nii work/affine.mat
FSLOUTPUTTYPE=NIFTI OMP_NUM_THREADS=4 niimath work/lesion-warped.nii -thr 0.5 -bin wlesion.nii -odt char
FSLOUTPUTTYPE=NIFTI_GZ OMP_NUM_THREADS=4 niimath wsub-01_T1w.nii.gz -mas wbt1sub-01_T1w.nii.gz wbsub-01_T1w.nii.gz -odt input
