% simulate_library.m
% Simulate every basis set in library.json with FID-A and export each
% metabolite's FID with export_fida.m for make-basis. Sets whose
% `simulation` is 'shaped' use real refocusing pulse shapes across the voxel
% (sim_shaped.m); the others use FID-A's ideal (instantaneous) pulses.
%
%   FIDA=/path/to/FID-A OUT=/path/to/out octave --no-gui simulate_library.m
%   (SET and METABOLITE restrict the run to one set or metabolite.)
%
% FID-A: https://github.com/CIC-methods/FID-A (BSD-3-Clause).
warning('off', 'all');
here = fileparts(mfilename('fullpath'));
addpath(genpath(getenv('FIDA')));
addpath(here);
addpath(fullfile(here, '..', '..', 'fida', 'validation'));
outdir = getenv('OUT');
lib = jsondecode(fileread(fullfile(here, 'library.json')));
S = load('spinSystems.mat');
for s = 1:numel(lib.sets)
  set = lib.sets(s);
  if iscell(set), set = set{1}; end
  if ~isempty(getenv('SET')) && ~strcmp(getenv('SET'), set.id), continue; end
  d = fullfile(outdir, set.id);
  mkdir(d);
  for m = 1:numel(lib.metabolites)
    name = lib.metabolites{m};
    if ~isempty(getenv('METABOLITE')) && ~strcmp(getenv('METABOLITE'), name), continue; end
    sys = S.(['sys' name]);
    kind = set.sequence;
    if isfield(set, 'simulation') && strcmp(set.simulation, 'shaped'), kind = 'shaped'; end
    switch kind
      case 'PRESS'
        out = sim_press(set.points, set.bandwidth_Hz, set.field_T, set.linewidth_Hz, sys, set.te1_ms, set.te2_ms);
      case 'STEAM'
        out = sim_steam(set.points, set.bandwidth_Hz, set.field_T, set.linewidth_Hz, sys, set.te_ms, set.tm_ms);
      case 'sLASER'
        out = sim_slaser_ideal(set.points, set.bandwidth_Hz, set.field_T, set.linewidth_Hz, sys, set.te_ms);
      case 'shaped'
        out = sim_shaped(set, sys);
      case 'SPECIAL'
        out = sim_spinecho(set.points, set.bandwidth_Hz, set.field_T, set.linewidth_Hz, sys, set.te_ms);
      otherwise
        error('unknown sequence %s', set.sequence);
    end
    out.te = set.te_ms;
    out.tr = 0;
    if ~isfield(out, 'txfrq'), out.txfrq = set.field_T * 42.577e6; end
    export_fida(out, fullfile(d, name));
    printf('%s %s\n', set.id, name);
    fflush(stdout);
  end
end

