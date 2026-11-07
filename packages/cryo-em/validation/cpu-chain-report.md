# CPU chain run, 2026-11-07

`validation/container-chain.mjs` ran the commands `relionCommand()` generates
for a whole chain in the `relion:5.1.1` container on the CPU. This checks
arguments and plumbing: every command starts, finds its inputs at the paths
the previous job wrote, finishes with `RELION_JOB_EXIT_SUCCESS` and writes
every required output of `relionOutputs()`. It is **not** ADR-0004's
reconstruction gate. That gate runs on GPUs with the tutorial settings and is
compared against a reference recorded with RELION's GUI. The resolution below
comes from 9 movies, 64 px particles and 427 particles, and says nothing about
the app's numerical quality.

## Setup

- RELION 5.1.1 (`Precision: BASE=double, CUDA-ACC=single`), CTFFIND 4.1.14,
  image `relion:5.1.1` built from the neurocontainers `relion` recipe. No GPU.
- Host: 8 cores, 31 GB RAM, shared with other work (load 8 to 35 during the run).
- Profile `{ cpus: 8, gpus: 0 }`.
- Mounts as the compute server makes them: the project read-write at
  `/project` (working directory), the tutorial directory read-only at
  `/data/examples/relion-tutorial` (data root `examples`). Each step ran in
  its own container (`docker run --rm -u 1000:1000 --shm-size 8g`). MPI steps
  ran under `mpirun --bind-to none -np N`.
- Data: the RELION tutorial movies (EMPIAR-10204, 0.885 Å/px, 200 kV,
  Cs 1.4 mm, 1.277 e/Å² per frame). Pattern `20170629_0002?_frameImage.tiff`
  matched 9 movies. The gain was `gain.mrc` given as a data-root file.

## Settings

The tutorial's settings except where reduced:

| Job | Options set (others are the table's defaults) |
| --- | --- |
| import | `angpix 0.885`, `kV 200`, `Cs 1.4` |
| motioncorr | `dosePerFrame 1.277`, `patchX/Y 5`, `gainFlip 1` (flip upside down) |
| ctffind | defaults (use the MotionCorr power spectra) |
| autopick | LoG `150`–`180` Å, `logUpperThreshold 5` |
| extract | `extractSize 256`, `doRescale`, `rescale 64` (3.54 Å/px) |
| class2d | `nrClasses 20` (tutorial 50), `nrIterGrad 100` (tutorial 200), `particleDiameter 200` |
| select | `ranker`, `minScore 0.25`; then `classes` mode with the ranker's classes |
| initialmodel | `nrIter 50` (default 200), `sym D2` (run in C1, aligned to D2) |
| refine3d | `sym D2`, `particleDiameter 200`; run to convergence |
| maskcreate | `inimaskThreshold 0.01`, `extendInimask 2`, `widthMaskEdge 3` |
| postprocess | defaults (automatic B-factor) |

## Result

| Job | Directory | Ranks × threads | Time |
| --- | --- | --- | --- |
| Import | `Import/job001` | 1 × 1 | 4 s |
| MotionCorr | `MotionCorr/job002` | 2 × 4 | 185 s |
| CtfFind | `CtfFind/job003` | 8 × 1 | 9 s |
| AutoPick (LoG) | `AutoPick/job004` | 8 × 1 | 22 s |
| Extract | `Extract/job005` | 8 × 1 | 8 s |
| Class2D (VDAM) | `Class2D/job006` | 1 × 8 | 377 s |
| Select (class ranker) | `Select/job007` | 1 × 1 | 18 s |
| Select (classes) | `Select/job008` | 1 × 1 | 3 s |
| InitialModel (VDAM) | `InitialModel/job009` | 1 × 8 | 2137 s |
| Refine3D | `Refine3D/job010` | 3 × 2 | 170 s |
| MaskCreate | `MaskCreate/job011` | 1 × 8 | 1 s |
| PostProcess | `PostProcess/job012` | 1 × 1 | 2 s |

The jobs took 49 minutes in total. The script was restarted once after
Class2D. The restart reused the finished jobs, and the times above for those
jobs are from the first pass. A first InitialModel with 100 iterations was
stopped at iteration 66 after 50 minutes, because later VDAM mini-batches grew
to about 2.5 minutes each on this host. It was rerun with 50 iterations.

- Movies 9, micrographs 9 (motion-corrected and CTF-fitted). Defocus is
  0.83 to 1.17 µm, and CTFFIND fits to 3.1 to 4.8 Å.
- Particles: 2017 extracted. The class ranker kept classes 2 and 20 at a
  score of 0.25, giving 427 particles. Selecting classes 2 and 20 by number
  (`classes` mode: two `relion_star_handler --select` calls and one
  `--combine`) gave the same 427 particles. The script compares the sorted
  `rlnImageName` lists.
- Refine3D converged after 14 iterations, with 9.85 Å in `run_model.star`.
- **PostProcess final resolution: 8.71 Å** (gold-standard FSC 0.143 with the
  mask, phase randomisation from 20.6 Å). The B-factor is −436 Å². It is fitted
  between 10 Å and 8.7 Å, too few shells to mean anything.
- Warnings: MaskCreate and PostProcess used the header pixel size (3.54 Å)
  because `angpix` is −1 by default, as in the GUI. `relion_star_handler
  --combine` warned that joined files share an optics group, which they do by
  construction.

## Commands

The argv the server would run, from `relionCommand()`. MPI steps carry the
server's launcher.

```sh
# Import/job001
ln -sfn /data/examples/relion-tutorial/Movies Import/job001/data
relion_import --do_movies --optics_group_name opticsGroup1 --angpix 0.885 --kV 200 --Cs 1.4 --Q0 0.1 --beamtilt_x 0 --beamtilt_y 0 --i 'Import/job001/data/20170629_0002?_frameImage.tiff' --odir Import/job001/ --ofile movies.star --pipeline_control Import/job001/

# MotionCorr/job002
mpirun --bind-to none -np 2 relion_run_motioncorr_mpi --i Import/job001/movies.star --o MotionCorr/job002/ --first_frame_sum 1 --last_frame_sum -1 --use_own --j 4 --float16 --bin_factor 1 --bfactor 150 --dose_per_frame 1.277 --preexposure 0 --patch_x 5 --patch_y 5 --eer_grouping 32 --gainref /data/examples/relion-tutorial/Movies/gain.mrc --gain_rot 0 --gain_flip 1 --dose_weighting --grouping_for_ps 3 --pipeline_control MotionCorr/job002/

# CtfFind/job003
mpirun --bind-to none -np 8 relion_run_ctffind_mpi --i MotionCorr/job002/corrected_micrographs.star --o CtfFind/job003/ --Box 512 --ResMin 30 --ResMax 5 --dFMin 5000 --dFMax 50000 --FStep 500 --dAst 100 --ctffind_exe /opt/ctffind-4.1.14/bin/ctffind --ctfWin -1 --is_ctffind4 --fast_search --use_given_ps --pipeline_control CtfFind/job003/

# AutoPick/job004
mpirun --bind-to none -np 8 relion_autopick_mpi --fn_topaz_exe relion_python_topaz --i CtfFind/job003/micrographs_ctf.star --odir AutoPick/job004/ --pickname autopick --LoG --LoG_diam_min 150 --LoG_diam_max 180 --shrink 0 --lowpass 20 --LoG_adjust_threshold 0 --LoG_upper_threshold 5 --pipeline_control AutoPick/job004/

# Extract/job005
mpirun --bind-to none -np 8 relion_preprocess_mpi --i CtfFind/job003/micrographs_ctf.star --coord_list AutoPick/job004/autopick.star --part_star Extract/job005/particles.star --part_dir Extract/job005/ --extract --extract_size 256 --float16 --scale 64 --norm --bg_radius 24 --white_dust -1 --black_dust -1 --invert_contrast --pipeline_control Extract/job005/

# Class2D/job006
relion_refine --o Class2D/job006/run --grad --class_inactivity_threshold 0.1 --grad_write_iter 10 --iter 100 --i Extract/job005/particles.star --dont_combine_weights_via_disc --pool 3 --pad 2 --ctf --tau2_fudge 2 --particle_diameter 200 --K 20 --flatten_solvent --zero_mask --center_classes --oversampling 1 --psi_step 12 --offset_range 5 --offset_step 2 --norm --scale --j 8 --pipeline_control Class2D/job006/

# Select/job007
relion_class_ranker --opt Class2D/job006/run_it100_optimiser.star --o Select/job007/ --fn_sel_parts particles.star --fn_sel_classavgs class_averages.star --fn_root rank --do_granularity_features --auto_select --min_score 0.25 --pipeline_control Select/job007/

# Select/job008
relion_star_handler --i Class2D/job006/run_it100_data.star --o Select/job008/classes_002_002.star --select rlnClassNumber --minval 2 --maxval 2
relion_star_handler --i Class2D/job006/run_it100_data.star --o Select/job008/classes_020_020.star --select rlnClassNumber --minval 20 --maxval 20
relion_star_handler --combine --i 'Select/job008/classes_002_002.star Select/job008/classes_020_020.star' --o Select/job008/particles.star --pipeline_control Select/job008/

# InitialModel/job009
relion_refine --o InitialModel/job009/run --iter 50 --grad --denovo_3dref --i Select/job007/particles.star --ctf --K 1 --sym C1 --flatten_solvent --zero_mask --dont_combine_weights_via_disc --pool 3 --pad 1 --particle_diameter 200 --oversampling 1 --healpix_order 1 --offset_range 6 --offset_step 2 --auto_sampling --tau2_fudge 4 --j 8 --pipeline_control InitialModel/job009/
rm -f InitialModel/job009/RELION_JOB_EXIT_SUCCESS
relion_align_symmetry --i InitialModel/job009/run_it050_model.star --o InitialModel/job009/initial_model.mrc --sym D2 --apply_sym --select_largest_class --pipeline_control InitialModel/job009/
touch InitialModel/job009/RELION_JOB_EXIT_SUCCESS

# Refine3D/job010
mpirun --bind-to none -np 3 relion_refine_mpi --o Refine3D/job010/run --auto_refine --split_random_halves --i Select/job007/particles.star --ref InitialModel/job009/initial_model.mrc --firstiter_cc --trust_ref_size --ini_high 60 --dont_combine_weights_via_disc --pool 3 --pad 2 --ctf --particle_diameter 200 --flatten_solvent --zero_mask --oversampling 1 --healpix_order 2 --auto_local_healpix_order 4 --offset_range 5 --offset_step 2 --sym D2 --low_resol_join_halves 40 --norm --scale --j 2 --pipeline_control Refine3D/job010/

# MaskCreate/job011
relion_mask_create --i Refine3D/job010/run_class001.mrc --o MaskCreate/job011/mask.mrc --lowpass 15 --ini_threshold 0.01 --extend_inimask 2 --width_soft_edge 3 --j 8 --pipeline_control MaskCreate/job011/

# PostProcess/job012
relion_postprocess --mask MaskCreate/job011/mask.mrc --i Refine3D/job010/run_half1_class001_unfil.mrc --o PostProcess/job012/postprocess --angpix -1 --auto_bfac --autob_lowres 10 --pipeline_control PostProcess/job012/
```

## What the run found

The first attempt failed at Import: `relion_import` itself refuses an
absolute `--i` ("Please import files by a relative path", `import.cpp`), not
only the GUI. Import now links the data-root directory into its job directory
(`ln -sfn /data/<root>/<path> <dir>data`) and imports through the link. As a
result, file names downstream carry the link path, for example
`MotionCorr/job002/Import/job001/data/20170629_00021_frameImage.mrc`. Later
jobs resolve them because every job mounts the data root at the same
`/data/<root>`.
