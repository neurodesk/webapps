// Commands RELION 5.1.1's GUI writes to note.txt for each case, spacing
// included; parity is on the shell words (see README.md). note.txt carries no
// MPI launcher. validation/pipeliner-parity.mjs asks RELION itself in the
// relion container and fails unless every line here is RELION's text. Two
// kinds of line are this package's own: import's first line, `ln -sfn`, links
// the data root into the job directory because relion_import refuses absolute
// paths (RELION's GUI expects the user to have made that link), and `select`
// with mode `classes` has no GUI command (relion_display selects
// interactively).

export const PROJECT = '0123456789abcdef0123456789abcdef';
export const CPU_PROFILE = { cpus: 16, gpus: 0 };
export const GPU_PROFILE = { cpus: 24, gpus: 4 };

// The beta-galactosidase tutorial (EMPIAR-10204) acquisition parameters.
const ACQUISITION = { angpix: 0.885, kV: 200, Cs: 1.4 };

function spec(command, inputs, options = {}) {
  return { tool: 'relion', command, project: PROJECT, inputs, options };
}

export const GUI_CASES = [
  {
    name: 'import movies, GUI defaults',
    spec: spec('import', { movies: { root: 'examples', path: 'relion30/Movies', pattern: '*.tiff' } }, ACQUISITION),
    profile: CPU_PROFILE,
    directory: 'Import/job001',
    gui: [
      'ln -sfn /data/examples/relion30/Movies Import/job001/data',
      'relion_import  --do_movies  --optics_group_name "opticsGroup1" --angpix 0.885 --kV 200 --Cs 1.4 --Q0 0.1 --beamtilt_x 0 --beamtilt_y 0 --i "Import/job001/data/*.tiff" --odir Import/job001/ --ofile movies.star  --pipeline_control Import/job001/',
    ],
  },
  {
    name: 'import single-frame micrographs from the root itself',
    spec: spec('import', { movies: { root: 'examples', path: '', pattern: '*.mrc' } }, { ...ACQUISITION, isMultiframe: false }),
    profile: CPU_PROFILE,
    directory: 'Import/job001',
    gui: [
      'ln -sfn /data/examples Import/job001/data',
      'relion_import  --do_micrographs  --optics_group_name "opticsGroup1" --angpix 0.885 --kV 200 --Cs 1.4 --Q0 0.1 --beamtilt_x 0 --beamtilt_y 0 --i "Import/job001/data/*.mrc" --odir Import/job001/ --ofile micrographs.star  --pipeline_control Import/job001/',
    ],
  },
  {
    name: 'motioncorr, GUI defaults',
    spec: spec('motioncorr', { movies: 'Import/job001/movies.star' }, { dosePerFrame: 1.277 }),
    profile: CPU_PROFILE,
    directory: 'MotionCorr/job002',
    gui: [
      '`which relion_run_motioncorr_mpi` --i Import/job001/movies.star --o MotionCorr/job002/ --first_frame_sum 1 --last_frame_sum -1 --use_own  --j 4 --float16 --bin_factor 1 --bfactor 150 --dose_per_frame 1.277 --preexposure 0 --patch_x 1 --patch_y 1 --eer_grouping 32 --dose_weighting  --grouping_for_ps 3   --pipeline_control MotionCorr/job002/',
    ],
  },
  {
    name: 'motioncorr with the tutorial gain reference and 5 x 5 patches',
    spec: { ...spec('motioncorr', { movies: 'Import/job001/movies.star', gain: { part: 'gain' } }, { dosePerFrame: 1.277, patchX: 5, patchY: 5, gainFlip: 1, groupFrames: 2 }) },
    parts: ['gain'],
    profile: { cpus: 18, gpus: 0 },
    directory: 'MotionCorr/job002',
    gui: [
      '`which relion_run_motioncorr_mpi` --i Import/job001/movies.star --o MotionCorr/job002/ --first_frame_sum 1 --last_frame_sum -1 --use_own  --j 4 --float16 --bin_factor 1 --bfactor 150 --dose_per_frame 1.277 --preexposure 0 --patch_x 5 --patch_y 5 --eer_grouping 32 --group_frames 2 --gainref MotionCorr/job002/gain.mrc --gain_rot 0 --gain_flip 1 --dose_weighting  --grouping_for_ps 3   --pipeline_control MotionCorr/job002/',
    ],
  },
  {
    name: 'ctffind, GUI defaults',
    spec: spec('ctffind', { micrographs: 'MotionCorr/job002/corrected_micrographs.star' }),
    profile: CPU_PROFILE,
    directory: 'CtfFind/job003',
    gui: [
      '`which relion_run_ctffind_mpi` --i MotionCorr/job002/corrected_micrographs.star --o CtfFind/job003/ --Box 512 --ResMin 30 --ResMax 5 --dFMin 5000 --dFMax 50000 --FStep 500 --dAst 100 --ctffind_exe /opt/ctffind-4.1.14/bin/ctffind --ctfWin -1 --is_ctffind4  --fast_search  --use_given_ps   --pipeline_control CtfFind/job003/',
    ],
  },
  {
    name: 'autopick LoG, GUI defaults',
    spec: spec('autopick', { micrographs: 'CtfFind/job003/micrographs_ctf.star' }),
    profile: CPU_PROFILE,
    directory: 'AutoPick/job004',
    gui: [
      '`which relion_autopick_mpi` --fn_topaz_exe relion_python_topaz --i CtfFind/job003/micrographs_ctf.star --odir AutoPick/job004/ --pickname autopick --LoG  --LoG_diam_min 200 --LoG_diam_max 250 --shrink 0 --lowpass 20 --LoG_adjust_threshold 0  --pipeline_control AutoPick/job004/',
    ],
  },
  {
    name: 'autopick LoG, tutorial diameters with an upper threshold',
    spec: spec('autopick', { micrographs: 'CtfFind/job003/micrographs_ctf.star' }, { logDiamMin: 150, logDiamMax: 180, logUpperThreshold: 5, logInvert: true }),
    profile: CPU_PROFILE,
    directory: 'AutoPick/job004',
    gui: [
      '`which relion_autopick_mpi` --fn_topaz_exe relion_python_topaz --i CtfFind/job003/micrographs_ctf.star --odir AutoPick/job004/ --pickname autopick --LoG  --LoG_diam_min 150 --LoG_diam_max 180 --shrink 0 --lowpass 20 --LoG_adjust_threshold 0 --LoG_upper_threshold 5 --Log_invert   --pipeline_control AutoPick/job004/',
    ],
  },
  {
    name: 'extract, GUI defaults',
    spec: spec('extract', { micrographs: 'CtfFind/job003/micrographs_ctf.star', coordinates: 'AutoPick/job004/autopick.star' }),
    profile: CPU_PROFILE,
    directory: 'Extract/job005',
    gui: [
      '`which relion_preprocess_mpi` --i CtfFind/job003/micrographs_ctf.star --coord_list AutoPick/job004/autopick.star --part_star Extract/job005/particles.star --part_dir Extract/job005/ --extract --extract_size 128 --float16  --norm --bg_radius 48 --white_dust -1 --black_dust -1 --invert_contrast   --pipeline_control Extract/job005/',
    ],
  },
  {
    name: 'extract 256 px rescaled to 64 px',
    spec: spec('extract', { micrographs: 'CtfFind/job003/micrographs_ctf.star', coordinates: 'AutoPick/job004/autopick.star' }, { extractSize: 256, doRescale: true, rescale: 64 }),
    profile: CPU_PROFILE,
    directory: 'Extract/job005',
    gui: [
      '`which relion_preprocess_mpi` --i CtfFind/job003/micrographs_ctf.star --coord_list AutoPick/job004/autopick.star --part_star Extract/job005/particles.star --part_dir Extract/job005/ --extract --extract_size 256 --float16  --scale 64 --norm --bg_radius 24 --white_dust -1 --black_dust -1 --invert_contrast   --pipeline_control Extract/job005/',
    ],
  },
  {
    name: 'class2d VDAM, GUI defaults on GPUs',
    spec: spec('class2d', { particles: 'Extract/job005/particles.star' }),
    profile: GPU_PROFILE,
    directory: 'Class2D/job006',
    gui: [
      '`which relion_refine` --o Class2D/job006/run --grad --class_inactivity_threshold 0.1 --grad_write_iter 10 --iter 200 --i Extract/job005/particles.star --dont_combine_weights_via_disc --pool 3 --pad 2  --ctf  --tau2_fudge 2 --particle_diameter 200 --K 1 --flatten_solvent  --zero_mask  --center_classes  --oversampling 1 --psi_step 12 --offset_range 5 --offset_step 2 --norm --scale  --j 24 --gpu ""  --pipeline_control Class2D/job006/',
    ],
  },
  {
    name: 'class2d VDAM, tutorial classes on CPUs',
    spec: spec('class2d', { particles: 'Extract/job005/particles.star' }, { nrClasses: 50, particleDiameter: 200, nrPool: 30 }),
    profile: CPU_PROFILE,
    directory: 'Class2D/job006',
    gui: [
      '`which relion_refine` --o Class2D/job006/run --grad --class_inactivity_threshold 0.1 --grad_write_iter 10 --iter 200 --i Extract/job005/particles.star --dont_combine_weights_via_disc --pool 30 --pad 2  --ctf  --tau2_fudge 2 --particle_diameter 200 --K 50 --flatten_solvent  --zero_mask  --center_classes  --oversampling 1 --psi_step 12 --offset_range 5 --offset_step 2 --norm --scale  --j 16  --pipeline_control Class2D/job006/',
    ],
  },
  {
    name: 'select with the class ranker, GUI defaults',
    spec: spec('select', { optimiser: 'Class2D/job006/run_it200_optimiser.star' }, { mode: 'ranker' }),
    profile: CPU_PROFILE,
    directory: 'Select/job007',
    gui: [
      '`which relion_class_ranker` --opt Class2D/job006/run_it200_optimiser.star --o Select/job007/ --fn_sel_parts particles.star --fn_sel_classavgs class_averages.star --fn_root rank --do_granularity_features  --auto_select  --min_score 0.5  --pipeline_control Select/job007/',
    ],
  },
  {
    name: 'select with the class ranker and a minimum particle count',
    spec: spec('select', { optimiser: 'Class2D/job006/run_it200_optimiser.star' }, { mode: 'ranker', minScore: 0.25, minParticles: 5000, minClasses: 10 }),
    profile: CPU_PROFILE,
    directory: 'Select/job007',
    gui: [
      '`which relion_class_ranker` --opt Class2D/job006/run_it200_optimiser.star --o Select/job007/ --fn_sel_parts particles.star --fn_sel_classavgs class_averages.star --select_min_nr_particles 5000 --fn_root rank --do_granularity_features  --auto_select  --min_score 0.25  --pipeline_control Select/job007/',
    ],
  },
  {
    name: 'select classes 3 to 5 (no GUI command: one star_handler call)',
    spec: spec('select', { particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes', classes: [5, 3, 4] }),
    profile: CPU_PROFILE,
    directory: 'Select/job007',
    gui: [
      'relion_star_handler --i Class2D/job006/run_it200_data.star --o Select/job007/particles.star --select rlnClassNumber --minval 3 --maxval 5 --pipeline_control Select/job007/',
    ],
  },
  {
    name: 'select classes 1, 2, 7 and 12 (no GUI command: ranges, then combine)',
    spec: spec('select', { particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes', classes: [12, 1, 7, 2] }),
    profile: CPU_PROFILE,
    directory: 'Select/job007',
    gui: [
      'relion_star_handler --i Class2D/job006/run_it200_data.star --o Select/job007/classes_001_002.star --select rlnClassNumber --minval 1 --maxval 2',
      'relion_star_handler --i Class2D/job006/run_it200_data.star --o Select/job007/classes_007_007.star --select rlnClassNumber --minval 7 --maxval 7',
      'relion_star_handler --i Class2D/job006/run_it200_data.star --o Select/job007/classes_012_012.star --select rlnClassNumber --minval 12 --maxval 12',
      'relion_star_handler --combine --i "Select/job007/classes_001_002.star Select/job007/classes_007_007.star Select/job007/classes_012_012.star" --o Select/job007/particles.star --pipeline_control Select/job007/',
    ],
  },
  {
    name: 'initialmodel, GUI defaults on GPUs',
    spec: spec('initialmodel', { particles: 'Select/job007/particles.star' }),
    profile: GPU_PROFILE,
    directory: 'InitialModel/job008',
    gui: [
      '`which relion_refine` --o InitialModel/job008/run --iter 200 --grad --denovo_3dref  --i Select/job007/particles.star --ctf --K 1 --sym C1  --flatten_solvent  --zero_mask  --dont_combine_weights_via_disc --pool 3 --pad 1  --particle_diameter 200 --oversampling 1  --healpix_order 1  --offset_range 6  --offset_step 2 --auto_sampling  --tau2_fudge 4 --j 24 --gpu ""  --pipeline_control InitialModel/job008/',
      'rm -f InitialModel/job008/RELION_JOB_EXIT_SUCCESS',
      '`which relion_align_symmetry` --i InitialModel/job008/run_it200_model.star --o InitialModel/job008/initial_model.mrc --sym C1  --apply_sym --select_largest_class  --pipeline_control InitialModel/job008/',
      'touch InitialModel/job008/RELION_JOB_EXIT_SUCCESS',
    ],
  },
  {
    name: 'initialmodel in C1, symmetrised to D2 (tutorial)',
    spec: spec('initialmodel', { particles: 'Select/job007/particles.star' }, { sym: 'D2', nrIter: 100 }),
    profile: GPU_PROFILE,
    directory: 'InitialModel/job008',
    gui: [
      '`which relion_refine` --o InitialModel/job008/run --iter 100 --grad --denovo_3dref  --i Select/job007/particles.star --ctf --K 1 --sym C1  --flatten_solvent  --zero_mask  --dont_combine_weights_via_disc --pool 3 --pad 1  --particle_diameter 200 --oversampling 1  --healpix_order 1  --offset_range 6  --offset_step 2 --auto_sampling  --tau2_fudge 4 --j 24 --gpu ""  --pipeline_control InitialModel/job008/',
      'rm -f InitialModel/job008/RELION_JOB_EXIT_SUCCESS',
      '`which relion_align_symmetry` --i InitialModel/job008/run_it100_model.star --o InitialModel/job008/initial_model.mrc --sym D2 --apply_sym --select_largest_class  --pipeline_control InitialModel/job008/',
      'touch InitialModel/job008/RELION_JOB_EXIT_SUCCESS',
    ],
  },
  {
    name: 'refine3d, GUI defaults on GPUs',
    spec: spec('refine3d', { particles: 'Select/job007/particles.star', reference: 'InitialModel/job008/initial_model.mrc' }),
    profile: GPU_PROFILE,
    directory: 'Refine3D/job009',
    gui: [
      '`which relion_refine_mpi` --o Refine3D/job009/run --auto_refine --split_random_halves --i Select/job007/particles.star --ref InitialModel/job008/initial_model.mrc --firstiter_cc --trust_ref_size --ini_high 60 --dont_combine_weights_via_disc --pool 3 --pad 2  --ctf --particle_diameter 200 --flatten_solvent --zero_mask --oversampling 1 --healpix_order 2 --auto_local_healpix_order 4 --offset_range 5 --offset_step 2 --sym C1 --low_resol_join_halves 40 --norm --scale  --j 4 --gpu ""  --pipeline_control Refine3D/job009/',
    ],
  },
  {
    name: 'refine3d in D2 with an uploaded mask, Blush and solvent-flattened FSCs on CPUs',
    spec: spec('refine3d', { particles: 'Select/job007/particles.star', reference: 'InitialModel/job008/initial_model.mrc', mask: { part: 'mask' } }, { sym: 'D2', doSolventFsc: true, doBlush: true, sampling: '3.7 degrees', autoLocalSampling: '0.9 degrees', offsetStep: 0.5 }),
    parts: ['mask'],
    profile: CPU_PROFILE,
    directory: 'Refine3D/job009',
    gui: [
      '`which relion_refine_mpi` --o Refine3D/job009/run --auto_refine --split_random_halves --i Select/job007/particles.star --ref InitialModel/job008/initial_model.mrc --firstiter_cc --trust_ref_size --ini_high 60 --blush  --blush_model v1.0 --dont_combine_weights_via_disc --pool 3 --pad 2  --ctf --particle_diameter 200 --flatten_solvent --zero_mask --solvent_mask Refine3D/job009/mask.mrc --solvent_correct_fsc  --oversampling 1 --healpix_order 3 --auto_local_healpix_order 5 --offset_range 5 --offset_step 1 --sym D2 --low_resol_join_halves 40 --norm --scale  --j 5  --pipeline_control Refine3D/job009/',
    ],
  },
  {
    name: 'maskcreate, GUI defaults',
    spec: spec('maskcreate', { map: 'Refine3D/job009/run_class001.mrc' }),
    profile: CPU_PROFILE,
    directory: 'MaskCreate/job010',
    gui: [
      '`which relion_mask_create` --i Refine3D/job009/run_class001.mrc --o MaskCreate/job010/mask.mrc --lowpass 15 --ini_threshold 0.02 --extend_inimask 3 --width_soft_edge 3 --j 16  --pipeline_control MaskCreate/job010/',
    ],
  },
  {
    name: 'maskcreate, tutorial settings',
    spec: spec('maskcreate', { map: 'Refine3D/job009/run_class001.mrc' }, { angpix: 1.244, inimaskThreshold: 0.01, extendInimask: 0, widthMaskEdge: 6 }),
    profile: CPU_PROFILE,
    directory: 'MaskCreate/job010',
    gui: [
      '`which relion_mask_create` --i Refine3D/job009/run_class001.mrc --o MaskCreate/job010/mask.mrc --lowpass 15 --angpix 1.244 --ini_threshold 0.01 --extend_inimask 0 --width_soft_edge 6 --j 16  --pipeline_control MaskCreate/job010/',
    ],
  },
  {
    name: 'postprocess, GUI defaults',
    spec: spec('postprocess', { halfMap: 'Refine3D/job009/run_half1_class001_unfil.mrc', mask: 'MaskCreate/job010/mask.mrc' }),
    profile: CPU_PROFILE,
    directory: 'PostProcess/job011',
    gui: [
      '`which relion_postprocess` --mask MaskCreate/job010/mask.mrc --i Refine3D/job009/run_half1_class001_unfil.mrc --o PostProcess/job011/postprocess  --angpix -1 --auto_bfac  --autob_lowres 10  --pipeline_control PostProcess/job011/',
    ],
  },
  {
    name: 'postprocess with an ad-hoc B-factor and low-pass filter',
    spec: spec('postprocess', { halfMap: 'Refine3D/job009/run_half2_class001_unfil.mrc', mask: 'MaskCreate/job010/mask.mrc' }, { angpix: 0.885, doAutoBfac: false, doAdhocBfac: true, adhocBfac: -50, doSkipFscWeighting: true, lowPass: 3.5 }),
    profile: CPU_PROFILE,
    directory: 'PostProcess/job011',
    gui: [
      '`which relion_postprocess` --mask MaskCreate/job010/mask.mrc --i Refine3D/job009/run_half2_class001_unfil.mrc --o PostProcess/job011/postprocess  --angpix 0.885 --adhoc_bfac -50 --skip_fsc_weighting  --low_pass 3.5  --pipeline_control PostProcess/job011/',
    ],
  },
  // The remaining option branches, numbers RELION passes as typed and the
  // values it computes in float32.
  {
    name: 'import with every acquisition option and a ? pattern',
    spec: spec('import', { movies: { root: 'examples', path: 'a/b', pattern: 'x_??.tif' } }, { angpix: 1.1, kV: 300, Cs: 2.7, Q0: 0.07, beamtiltX: 0.2, beamtiltY: -0.1 }),
    profile: CPU_PROFILE,
    directory: 'Import/job001',
    gui: [
      'ln -sfn /data/examples/a/b Import/job001/data',
      'relion_import  --do_movies  --optics_group_name "opticsGroup1" --angpix 1.1 --kV 300 --Cs 2.7 --Q0 0.07 --beamtilt_x 0.2 --beamtilt_y -0.1 --i "Import/job001/data/x_??.tif" --odir Import/job001/ --ofile movies.star  --pipeline_control Import/job001/',
    ],
  },
  {
    name: 'import passes a seven-digit pixel size as typed',
    spec: spec('import', { movies: { root: 'examples', path: 'a', pattern: '*.tiff' } }, { angpix: 0.8851234, kV: 200, Cs: 1.4 }),
    profile: CPU_PROFILE,
    directory: 'Import/job001',
    gui: [
      'ln -sfn /data/examples/a Import/job001/data',
      'relion_import  --do_movies  --optics_group_name "opticsGroup1" --angpix 0.8851234 --kV 200 --Cs 1.4 --Q0 0.1 --beamtilt_x 0 --beamtilt_y 0 --i "Import/job001/data/*.tiff" --odir Import/job001/ --ofile movies.star  --pipeline_control Import/job001/',
    ],
  },
  {
    name: 'motioncorr on one rank with a data-root gain, rotated and flipped, no power spectra',
    spec: spec('motioncorr', { movies: 'Import/job001/movies.star', gain: { root: 'examples', path: 'relion-tutorial/Movies/gain.mrc' } }, { dosePerFrame: 1.277, firstFrameSum: 2, lastFrameSum: 30, eerGrouping: 20, doFloat16: false, doSavePs: false, bfactor: 200, binFactor: 2, preExposure: 1.5, doSaveNoDW: true, gainRot: 3, gainFlip: 2, patchX: 4, patchY: 3 }),
    profile: { cpus: 7, gpus: 0 },
    directory: 'MotionCorr/job002',
    gui: [
      '`which relion_run_motioncorr` --i Import/job001/movies.star --o MotionCorr/job002/ --first_frame_sum 2 --last_frame_sum 30 --use_own  --j 7 --bin_factor 2 --bfactor 200 --dose_per_frame 1.277 --preexposure 1.5 --patch_x 4 --patch_y 3 --eer_grouping 20 --gainref /data/examples/relion-tutorial/Movies/gain.mrc --gain_rot 3 --gain_flip 2 --dose_weighting  --save_noDW   --pipeline_control MotionCorr/job002/',
    ],
  },
  {
    name: 'motioncorr without dose weighting, power spectra grouped every frame',
    spec: spec('motioncorr', { movies: 'Import/job001/movies.star' }, { dosePerFrame: 1.277, doDoseWeighting: false, doSaveNoDW: true, groupForPs: 0.1, binFactor: 1.5 }),
    profile: { cpus: 3, gpus: 0 },
    directory: 'MotionCorr/job002',
    gui: [
      '`which relion_run_motioncorr` --i Import/job001/movies.star --o MotionCorr/job002/ --first_frame_sum 1 --last_frame_sum -1 --use_own  --j 3 --float16 --bin_factor 1.5 --bfactor 150 --dose_per_frame 1.277 --preexposure 0 --patch_x 1 --patch_y 1 --eer_grouping 32 --grouping_for_ps 1   --pipeline_control MotionCorr/job002/',
    ],
  },
  {
    name: 'motioncorr ignores the profile GPUs, rounds a half power-spectrum group up',
    spec: spec('motioncorr', { movies: 'Import/job001/movies.star' }, { dosePerFrame: 2, groupForPs: 5 }),
    profile: { cpus: 8, gpus: 1 },
    directory: 'MotionCorr/job002',
    gui: [
      '`which relion_run_motioncorr_mpi` --i Import/job001/movies.star --o MotionCorr/job002/ --first_frame_sum 1 --last_frame_sum -1 --use_own  --j 4 --float16 --bin_factor 1 --bfactor 150 --dose_per_frame 2 --preexposure 0 --patch_x 1 --patch_y 1 --eer_grouping 32 --dose_weighting  --grouping_for_ps 3   --pipeline_control MotionCorr/job002/',
    ],
  },
  {
    name: 'ctffind from imported micrographs with phase shifts, exhaustive search and a window',
    spec: spec('ctffind', { micrographs: 'Import/job001/micrographs.star' }, { useNoDW: true, doPhaseshift: true, phaseMin: 10, phaseMax: 170, phaseStep: 5, dAst: 500, useGivenPs: false, slowSearch: true, box: 256, resMin: 25.5, resMax: 3.5, dfMin: 1000, dfMax: 30000, dfStep: 250, ctfWin: 1024 }),
    profile: { cpus: 5, gpus: 0 },
    directory: 'CtfFind/job003',
    gui: [
      '`which relion_run_ctffind_mpi` --i Import/job001/micrographs.star --o CtfFind/job003/ --Box 256 --ResMin 25.5 --ResMax 3.5 --dFMin 1000 --dFMax 30000 --FStep 250 --dAst 500 --use_noDW  --do_phaseshift  --phase_min 10 --phase_max 170 --phase_step 5 --ctffind_exe /opt/ctffind-4.1.14/bin/ctffind --ctfWin 1024 --is_ctffind4   --pipeline_control CtfFind/job003/',
    ],
  },
  {
    name: 'autopick LoG without a low-pass limit, adjusted thresholds',
    spec: spec('autopick', { micrographs: 'MotionCorr/job002/corrected_micrographs.star' }, { logDiamMin: 120.5, logDiamMax: 160, logMaxres: -1, logAdjustThreshold: -0.5, logUpperThreshold: 998.5 }),
    profile: CPU_PROFILE,
    directory: 'AutoPick/job004',
    gui: [
      '`which relion_autopick_mpi` --fn_topaz_exe relion_python_topaz --i MotionCorr/job002/corrected_micrographs.star --odir AutoPick/job004/ --pickname autopick --LoG  --LoG_diam_min 120.5 --LoG_diam_max 160 --shrink 0 --lowpass -1 --LoG_adjust_threshold -0.5 --LoG_upper_threshold 998.5  --pipeline_control AutoPick/job004/',
    ],
  },
  {
    name: 'extract with a background diameter, dust removal and an FOM threshold',
    spec: spec('extract', { micrographs: 'CtfFind/job003/micrographs_ctf.star', coordinates: 'AutoPick/job004/autopick.star' }, { extractSize: 256, doRescale: true, rescale: 100, bgDiameter: 200, whiteDust: 5, blackDust: 4.5, doFomThreshold: true, minimumPickFom: -0.5 }),
    profile: CPU_PROFILE,
    directory: 'Extract/job005',
    gui: [
      '`which relion_preprocess_mpi` --i CtfFind/job003/micrographs_ctf.star --coord_list AutoPick/job004/autopick.star --part_star Extract/job005/particles.star --part_dir Extract/job005/ --extract --extract_size 256 --minimum_pick_fom -0.5 --float16  --scale 100 --norm --bg_radius 39 --white_dust 5 --black_dust 4.5 --invert_contrast   --pipeline_control Extract/job005/',
    ],
  },
  {
    name: 'extract on one CPU without normalisation, inversion or float16',
    spec: spec('extract', { micrographs: 'CtfFind/job003/micrographs_ctf.star', coordinates: 'AutoPick/job004/autopick.star' }, { doInvert: false, doFloat16: false, doNorm: false, extractSize: 100 }),
    profile: { cpus: 1, gpus: 0 },
    directory: 'Extract/job005',
    gui: [
      '`which relion_preprocess` --i CtfFind/job003/micrographs_ctf.star --coord_list AutoPick/job004/autopick.star --part_star Extract/job005/particles.star --part_dir Extract/job005/ --extract --extract_size 100  --pipeline_control Extract/job005/',
    ],
  },
  {
    name: 'extract rescaled to a size that truncates the background radius',
    spec: spec('extract', { micrographs: 'CtfFind/job003/micrographs_ctf.star', coordinates: 'AutoPick/job004/autopick.star' }, { extractSize: 250, doRescale: true, rescale: 66 }),
    profile: CPU_PROFILE,
    directory: 'Extract/job005',
    gui: [
      '`which relion_preprocess_mpi` --i CtfFind/job003/micrographs_ctf.star --coord_list AutoPick/job004/autopick.star --part_star Extract/job005/particles.star --part_dir Extract/job005/ --extract --extract_size 250 --float16  --scale 66 --norm --bg_radius 24 --white_dust -1 --black_dust -1 --invert_contrast   --pipeline_control Extract/job005/',
    ],
  },
  {
    name: 'class2d without CTF, alignment, centring or masking, with every I/O option',
    spec: spec('class2d', { particles: 'Select/job007/particles.star' }, { doCtfCorrection: false, highresLimit: 8, doCenter: false, doZeroMask: false, performAlignment: false, nrPool: 10, doParallelDiscio: false, doPrereadImages: true, doCombineThruDisc: true, tauFudge: 1.5, nrIterGrad: 100, particleDiameter: 180 }),
    profile: CPU_PROFILE,
    directory: 'Class2D/job006',
    gui: [
      '`which relion_refine` --o Class2D/job006/run --grad --class_inactivity_threshold 0.1 --grad_write_iter 10 --iter 100 --i Select/job007/particles.star --no_parallel_disc_io --preread_images  --pool 10 --pad 2  --tau2_fudge 1.5 --particle_diameter 180 --K 1 --flatten_solvent  --strict_highres_exp 8 --oversampling 1 --skip_align  --norm --scale  --j 16  --pipeline_control Class2D/job006/',
    ],
  },
  {
    name: 'class2d ignoring CTFs to the first peak with coarser sampling on GPUs',
    spec: spec('class2d', { particles: 'Extract/job005/particles.star' }, { ctfIntactFirstPeak: true, allowCoarser: true, psiSampling: 2.5, offsetRange: 3, offsetStep: 0.75 }),
    profile: { cpus: 12, gpus: 2 },
    directory: 'Class2D/job006',
    gui: [
      '`which relion_refine` --o Class2D/job006/run --grad --class_inactivity_threshold 0.1 --grad_write_iter 10 --iter 200 --i Extract/job005/particles.star --dont_combine_weights_via_disc --pool 3 --pad 2  --ctf  --ctf_intact_first_peak  --tau2_fudge 2 --particle_diameter 200 --K 1 --flatten_solvent  --zero_mask  --center_classes  --oversampling 1 --psi_step 5 --offset_range 3 --offset_step 1.5 --allow_coarser_sampling --norm --scale  --j 12 --gpu ""  --pipeline_control Class2D/job006/',
    ],
  },
  {
    name: 'select with the class ranker and a minimum class count',
    spec: spec('select', { optimiser: 'Class2D/job006/run_it100_optimiser.star' }, { mode: 'ranker', minClasses: 10, minScore: 0.35 }),
    profile: CPU_PROFILE,
    directory: 'Select/job007',
    gui: [
      '`which relion_class_ranker` --opt Class2D/job006/run_it100_optimiser.star --o Select/job007/ --fn_sel_parts particles.star --fn_sel_classavgs class_averages.star --select_min_nr_classes 10 --fn_root rank --do_granularity_features  --auto_select  --min_score 0.35  --pipeline_control Select/job007/',
    ],
  },
  {
    name: 'initialmodel with two classes in D2 from the start, every I/O option',
    spec: spec('initialmodel', { particles: 'Extract/job005/particles.star' }, { nrClasses: 2, doRunC1: false, sym: 'D2', doSolvent: false, ctfIntactFirstPeak: true, nrPool: 5, doParallelDiscio: false, doPrereadImages: true, doCombineThruDisc: true, tauFudge: 2.5, particleDiameter: 180, nrIter: 50 }),
    profile: CPU_PROFILE,
    directory: 'InitialModel/job008',
    gui: [
      '`which relion_refine` --o InitialModel/job008/run --iter 50 --grad --denovo_3dref  --i Extract/job005/particles.star --ctf --ctf_intact_first_peak --K 2 --sym D2 --zero_mask  --no_parallel_disc_io --preread_images  --pool 5 --pad 1  --particle_diameter 180 --oversampling 1  --healpix_order 1  --offset_range 6  --offset_step 2 --auto_sampling  --tau2_fudge 2.5 --j 16  --pipeline_control InitialModel/job008/',
      'rm -f InitialModel/job008/RELION_JOB_EXIT_SUCCESS',
      '`which relion_align_symmetry` --i InitialModel/job008/run_it050_model.star --o InitialModel/job008/initial_model.mrc --sym C1  --apply_sym --select_largest_class  --pipeline_control InitialModel/job008/',
      'touch InitialModel/job008/RELION_JOB_EXIT_SUCCESS',
    ],
  },
  {
    name: 'initialmodel without CTF correction, lower-case c1',
    spec: spec('initialmodel', { particles: 'Select/job007/particles.star' }, { doCtfCorrection: false, sym: 'c1' }),
    profile: CPU_PROFILE,
    directory: 'InitialModel/job008',
    gui: [
      '`which relion_refine` --o InitialModel/job008/run --iter 200 --grad --denovo_3dref  --i Select/job007/particles.star --K 1 --sym C1  --flatten_solvent  --zero_mask  --dont_combine_weights_via_disc --pool 3 --pad 1  --particle_diameter 200 --oversampling 1  --healpix_order 1  --offset_range 6  --offset_step 2 --auto_sampling  --tau2_fudge 4 --j 16  --pipeline_control InitialModel/job008/',
      'rm -f InitialModel/job008/RELION_JOB_EXIT_SUCCESS',
      '`which relion_align_symmetry` --i InitialModel/job008/run_it200_model.star --o InitialModel/job008/initial_model.mrc --sym C1  --apply_sym --select_largest_class  --pipeline_control InitialModel/job008/',
      'touch InitialModel/job008/RELION_JOB_EXIT_SUCCESS',
    ],
  },
  {
    name: 'refine3d from absolute greyscale with a MaskCreate mask, amyloid Blush and faster local searches on GPUs',
    spec: spec('refine3d', { particles: 'Extract/job005/particles.star', reference: 'InitialModel/job008/initial_model.mrc', mask: 'MaskCreate/job010/mask.mrc' }, { refCorrectGreyscale: true, trustRefSize: false, iniHigh: 0, doCtfCorrection: false, doZeroMask: false, doBlush: true, blushVersion: 'amy-v1.0', autoFaster: true, doPad1: true, doParallelDiscio: false, doPrereadImages: true, doCombineThruDisc: true, sampling: '30 degrees', autoLocalSampling: '0.1 degrees', offsetRange: 3.5, offsetStep: 0.3 }),
    profile: { cpus: 8, gpus: 2 },
    directory: 'Refine3D/job009',
    gui: [
      '`which relion_refine_mpi` --o Refine3D/job009/run --auto_refine --split_random_halves --i Extract/job005/particles.star --ref InitialModel/job008/initial_model.mrc --blush  --blush_model amy-v1.0 --no_parallel_disc_io --preread_images  --pool 3 --pad 1  --auto_ignore_angles --auto_resol_angles --particle_diameter 200 --flatten_solvent --solvent_mask MaskCreate/job010/mask.mrc --oversampling 1 --healpix_order 0 --auto_local_healpix_order 8 --offset_range 3.5 --offset_step 0.6 --sym C1 --low_resol_join_halves 40 --norm --scale  --j 2 --gpu ""  --pipeline_control Refine3D/job009/',
    ],
  },
  {
    name: 'refine3d on three CPUs ignoring CTFs to the first peak, solvent FSC without a mask',
    spec: spec('refine3d', { particles: 'Select/job007/particles.star', reference: 'InitialModel/job008/initial_model.mrc' }, { ctfIntactFirstPeak: true, iniHigh: 40, doSolventFsc: true }),
    profile: { cpus: 3, gpus: 0 },
    directory: 'Refine3D/job009',
    gui: [
      '`which relion_refine_mpi` --o Refine3D/job009/run --auto_refine --split_random_halves --i Select/job007/particles.star --ref InitialModel/job008/initial_model.mrc --firstiter_cc --trust_ref_size --ini_high 40 --dont_combine_weights_via_disc --pool 3 --pad 2  --ctf --ctf_intact_first_peak --particle_diameter 200 --flatten_solvent --zero_mask --oversampling 1 --healpix_order 2 --auto_local_healpix_order 4 --offset_range 5 --offset_step 2 --sym C1 --low_resol_join_halves 40 --norm --scale  --j 1  --pipeline_control Refine3D/job009/',
    ],
  },
  {
    name: 'maskcreate from the initial model without a low-pass filter',
    spec: spec('maskcreate', { map: 'InitialModel/job008/initial_model.mrc' }, { lowpassFilter: -1, angpix: 0.885, inimaskThreshold: 0.005, extendInimask: 2, widthMaskEdge: 8 }),
    profile: { cpus: 1, gpus: 0 },
    directory: 'MaskCreate/job010',
    gui: [
      '`which relion_mask_create` --i InitialModel/job008/initial_model.mrc --o MaskCreate/job010/mask.mrc --angpix 0.885 --ini_threshold 0.005 --extend_inimask 2 --width_soft_edge 8 --j 1  --pipeline_control MaskCreate/job010/',
    ],
  },
  {
    name: 'postprocess with an uploaded mask and no B-factor sharpening',
    spec: spec('postprocess', { halfMap: 'Refine3D/job009/run_half1_class001_unfil.mrc', mask: { part: 'mask' } }, { doAutoBfac: false, autobLowres: 8 }),
    parts: ['mask'],
    profile: CPU_PROFILE,
    directory: 'PostProcess/job011',
    gui: [
      '`which relion_postprocess` --mask PostProcess/job011/mask.mrc --i Refine3D/job009/run_half1_class001_unfil.mrc --o PostProcess/job011/postprocess  --angpix -1  --pipeline_control PostProcess/job011/',
    ],
  },
  {
    name: 'postprocess with both automatic and ad-hoc B-factors',
    spec: spec('postprocess', { halfMap: 'Refine3D/job009/run_half1_class001_unfil.mrc', mask: 'MaskCreate/job010/mask.mrc' }, { doAutoBfac: true, autobLowres: 8.5, doAdhocBfac: true, adhocBfac: -120 }),
    profile: CPU_PROFILE,
    directory: 'PostProcess/job011',
    gui: [
      '`which relion_postprocess` --mask MaskCreate/job010/mask.mrc --i Refine3D/job009/run_half1_class001_unfil.mrc --o PostProcess/job011/postprocess  --angpix -1 --auto_bfac  --autob_lowres 8.5 --adhoc_bfac -120  --pipeline_control PostProcess/job011/',
    ],
  },
  {
    name: 'maskcreate passes a tiny threshold without an exponent',
    spec: spec('maskcreate', { map: 'Refine3D/job009/run_class001.mrc' }, { inimaskThreshold: 1e-7, lowpassFilter: 12.5, angpix: 1.0605 }),
    profile: CPU_PROFILE,
    directory: 'MaskCreate/job010',
    gui: [
      '`which relion_mask_create` --i Refine3D/job009/run_class001.mrc --o MaskCreate/job010/mask.mrc --lowpass 12.5 --angpix 1.0605 --ini_threshold 0.0000001 --extend_inimask 3 --width_soft_edge 3 --j 16  --pipeline_control MaskCreate/job010/',
    ],
  },
  {
    name: 'class2d with float32-rounded angular and offset steps',
    spec: spec('class2d', { particles: 'Extract/job005/particles.star' }, { psiSampling: 1.2345678, offsetStep: 0.333, highresLimit: 7.25, offsetRange: 2.5 }),
    profile: CPU_PROFILE,
    directory: 'Class2D/job006',
    gui: [
      '`which relion_refine` --o Class2D/job006/run --grad --class_inactivity_threshold 0.1 --grad_write_iter 10 --iter 200 --i Extract/job005/particles.star --dont_combine_weights_via_disc --pool 3 --pad 2  --ctf  --tau2_fudge 2 --particle_diameter 200 --K 1 --flatten_solvent  --zero_mask  --strict_highres_exp 7.25 --center_classes  --oversampling 1 --psi_step 2.46914 --offset_range 2.5 --offset_step 0.666 --norm --scale  --j 16  --pipeline_control Class2D/job006/',
    ],
  },
  {
    name: 'refine3d with a float32-rounded offset step',
    spec: spec('refine3d', { particles: 'Extract/job005/particles.star', reference: 'InitialModel/job008/initial_model.mrc' }, { offsetStep: 0.1234567, iniHigh: 35.5, particleDiameter: 185.5 }),
    profile: { cpus: 4, gpus: 0 },
    directory: 'Refine3D/job009',
    gui: [
      '`which relion_refine_mpi` --o Refine3D/job009/run --auto_refine --split_random_halves --i Extract/job005/particles.star --ref InitialModel/job008/initial_model.mrc --firstiter_cc --trust_ref_size --ini_high 35.5 --dont_combine_weights_via_disc --pool 3 --pad 2  --ctf --particle_diameter 185.5 --flatten_solvent --zero_mask --oversampling 1 --healpix_order 2 --auto_local_healpix_order 4 --offset_range 5 --offset_step 0.246913 --sym C1 --low_resol_join_halves 40 --norm --scale  --j 1  --pipeline_control Refine3D/job009/',
    ],
  },
];

/**
 * The words a POSIX shell gives for one note.txt line: whitespace separates
 * words, double quotes group (and "" is an empty word), and `which X`
 * resolves to X.
 */
export function shellWords(line) {
  const words = [];
  let word = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      const end = line.indexOf('"', index + 1);
      if (end < 0) throw new Error(`unterminated quote in ${line}`);
      word = (word ?? '') + line.slice(index + 1, end);
      index = end;
    } else if (char === '`') {
      const end = line.indexOf('`', index + 1);
      if (end < 0) throw new Error(`unterminated backtick in ${line}`);
      const inner = line.slice(index + 1, end).trim().split(/\s+/);
      if (inner.length !== 2 || inner[0] !== 'which') throw new Error(`unsupported command substitution in ${line}`);
      word = (word ?? '') + inner[1];
      index = end;
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}
