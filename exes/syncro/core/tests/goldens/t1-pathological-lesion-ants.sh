greedy-rs -threads 4 -d 3 -a -m NMI -i work/primary.nii work/pathological.nii -o work/pathological.mat -n 100x50x10 -ia-image-centers
synthsr work/primary.nii work/t1.nii --threads 4 --force
BC_NUM_THREADS=4 brainchop-mindgrab work/t1.nii -o work/brain.nii --mask work/mask.nii
ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=4 antsRegistration --dimensionality 3 --float 1 --random-seed 42 -r '[work/template.nii,work/brain-f32.nii,1]' --metric 'mattes[work/template.nii,work/brain-f32.nii,1,32,regular,0.2]' --transform 'Affine[0.25]' --convergence 2100x1200x1200x0 --smoothing-sigmas 3x2x1x0 --shrink-factors 4x2x2x1 --metric 'mattes[work/template.nii,work/brain-f32.nii,1,32]' --transform 'SyN[0.2,3,0]' --convergence '[40x20x0,1e-7,8]' --smoothing-sigmas 2x1x0 --shrink-factors 4x2x1 -u 0 -z 1 --output '[work/ants-,work/ants-brain.nii.gz]' --verbose 1
ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=4 antsApplyTransforms -d 3 --float 1 -i work/primary.nii -r work/template.nii -o wsub-01_T1w.nii.gz -n Linear -f 0 -t work/ants-1Warp.nii.gz -t work/ants-0GenericAffine.mat
greedy-rs -threads 4 -d 3 -rf work/primary.nii -rm work/pathological.nii work/pathological-primary-grid.nii -r work/pathological.mat
ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=4 antsApplyTransforms -d 3 --float 1 -i work/pathological-primary-grid.nii -r work/template.nii -o wsub-01_FLAIR.nii -n Linear -f 0 -t work/ants-1Warp.nii.gz -t work/ants-0GenericAffine.mat
FSLOUTPUTTYPE=NIFTI OMP_NUM_THREADS=4 niimath work/lesion.nii -s 1.2739827004487725 work/lesion-smoothed.nii -odt float
greedy-rs -threads 4 -d 3 -rf work/primary.nii -rm work/lesion-smoothed.nii work/lesion-primary-grid.nii -ri NN -r work/pathological.mat
ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=4 antsApplyTransforms -d 3 --float 1 -i work/lesion-primary-grid.nii -r work/template.nii -o work/lesion-warped.nii -n NearestNeighbor -f 0 -t work/ants-1Warp.nii.gz -t work/ants-0GenericAffine.mat
FSLOUTPUTTYPE=NIFTI OMP_NUM_THREADS=4 niimath work/lesion-warped.nii -thr 0.5 -bin wlesion.nii -odt char
FSLOUTPUTTYPE=NIFTI_GZ OMP_NUM_THREADS=4 niimath wsub-01_T1w.nii.gz -mas wbt1sub-01_T1w.nii.gz wbsub-01_T1w.nii.gz -odt input
