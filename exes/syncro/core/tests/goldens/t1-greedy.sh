synthsr /work/primary.nii /work/t1.nii --threads 4
BC_NUM_THREADS=4 brainchop-mindgrab /work/t1.nii -o /work/brain.nii --mask /work/mask.nii
greedy-rs -threads 4 -d 3 -a -m NMI -i /work/template.nii /work/brain-f32.nii -o /work/affine.mat -n 100x50x10 -ia-image-centers
greedy-rs -threads 4 -d 3 -m NMI -i /work/template.nii /work/brain-f32.nii -it /work/affine.mat -o /work/warp.nii -sv -n 100x50x10
greedy-rs -threads 4 -d 3 -rf /work/template.nii -rm /work/brain-f32.nii /out/wbt1sub-01_T1w.nii.gz -r /work/warp.nii /work/affine.mat
greedy-rs -threads 4 -d 3 -rf /work/template.nii -rm /work/primary.nii /out/wsub-01_T1w.nii.gz -r /work/warp.nii /work/affine.mat
OMP_NUM_THREADS=4 niimath /out/wsub-01_T1w.nii.gz -mas /out/wbt1sub-01_T1w.nii.gz /out/wbsub-01_T1w.nii.gz -odt input
