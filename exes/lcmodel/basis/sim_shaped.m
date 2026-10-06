% sim_shaped.m
% PRESS or semi-LASER with shaped refocusing pulses, spatially resolved
% across the voxel, for one spin system. Derived from FID-A's
% run_simPressShaped_fast.m and run_simSemiLASERShaped_fast.m (Copyright
% 2020-2021 Jamie Near, Dana Goerzen, Muhammad G Saleh, BSD-3-Clause),
% which use Zhang et al.'s factorisation (Med Phys 2017;44:4169-78): the
% density matrix is averaged over the x positions after the x-selective
% pulse(s), then propagated through the y-selective pulse(s) at each y
% position. That is exact for separable slice selection and costs nX + nY
% pulse simulations instead of nX * nY. Excitation is instantaneous, as in
% FID-A; coherence-order filtering (sim_COF) stands in for the crushers.
%
% The transmitter sits at set.centre_ppm (FID-A simulates with 0 Hz there);
% the result is re-centred to 4.65 ppm at 0 Hz, the convention of the rest
% of the basis library.
%
% out = sim_shaped(set, sys)
%   set: a library.json entry with sequence 'PRESS' (te1_ms, te2_ms) or
%   'sLASER' (te_ms), and pulse (file, type, tp_ms), thk_cm, fov_cm, grid.
function out = sim_shaped(set, sys)
  pkg load signal;
  gamma = 42577000;
  centreFreq = set.centre_ppm;
  pulse = set.pulse;
  if isfield(pulse, 'w1max_kHz')
    % Adiabatic pulse: B1 for its 5 ms reference duration (FID-A asks).
    addpath(fullfile(fileparts(mfilename('fullpath')), 'w1max-input'));
    setenv('FIDA_W1MAX_KHZ', num2str(pulse.w1max_kHz));
  end
  RF = rf_resample(io_loadRFwaveform(pulse.file, pulse.type, 0), pulse.resample);
  tp = pulse.tp_ms;
  if RF.isGM
    error('gradient-modulated pulses are not supported');
  end
  G = (RF.tbw / (tp / 1000)) / (gamma * set.thk_cm / 10000);
  pos = linspace(-set.fov_cm / 2, set.fov_cm / 2, set.grid);
  for k = 1:numel(sys)
    sys(k).shifts = sys(k).shifts - centreFreq;
  end
  [H, d0] = sim_Hamiltonian(sys, set.field_T);
  d0 = sim_excite(d0, H, 'x');
  d0 = sim_COF(H, d0, -1);
  switch set.sequence
    case 'PRESS'
      delays = [set.te1_ms - tp, set.te2_ms - tp];
      if any(delays < 0), error('TE1 and TE2 must exceed the pulse duration'); end
      ph = 90;
      first = @(d, x) press_first(d, H, RF, tp, ph, x, G, delays);
      second = @(d, y) press_second(d, H, RF, tp, ph, y, G, delays);
    case 'sLASER'
      tau1 = (set.te_ms / 4 - tp) / 2;
      tau2 = set.te_ms / 4 - tp;
      if tau1 < 0, error('TE/4 must exceed the pulse duration'); end
      ph = 0;
      first = @(d, x) slaser_pair(sim_evolve(d, H, tau1 / 1000), H, RF, tp, ph, x, G, tau2, 1);
      second = @(d, y) slaser_pair(d, H, RF, tp, ph, y, G, tau2, 2, tau1);
    otherwise
      error('no shaped simulation for %s', set.sequence);
  end
  dsum = [];
  for X = 1:numel(pos)
    dsum = sim_dAdd(dsum, first(d0, pos(X)));
  end
  % The readout is linear in the density matrix and costs more than all the
  % pulses (8192 points), so sum over y first and read out once; FID-A reads
  % out each y position and adds the spectra, which is the same sum.
  dy = [];
  for Y = 1:numel(pos)
    dy = sim_dAdd(dy, second(dsum, pos(Y)));
  end
  [out, ~] = sim_readout(dy, H, set.points, set.bandwidth_Hz, set.linewidth_Hz, 90);
  % FID-A's normalisation: mean over positions, scaled to the voxel.
  out = op_ampScale(out, 1 / set.grid ^ 2);
  out = op_ampScale(out, (set.fov_cm / set.thk_cm) ^ 2);
  out.ppm = out.ppm - (4.65 - centreFreq);
  shift = (4.65 - centreFreq) * set.field_T * gamma / 1e6;
  out = op_freqshift(out, shift);
  out.ppm = out.ppm + (4.65 - centreFreq);
  out.seq = set.sequence;
  out.sim = 'shaped';
end

function d = press_first(d, H, RF, tp, ph, x, G, delays)
  d = sim_evolve(d, H, delays(1) / 2000);
  d = sim_shapedRF(d, H, RF, tp, 180, ph, x, G);
  d = sim_COF(H, d, 1);
  d = sim_evolve(d, H, (delays(1) + delays(2)) / 2000);
end

function d = press_second(d, H, RF, tp, ph, y, G, delays)
  d = sim_shapedRF(d, H, RF, tp, 180, ph, y, G);
  d = sim_COF(H, d, -1);
  d = sim_evolve(d, H, delays(2) / 2000);
end

% Two adiabatic refocusing pulses along one axis. The first pair follows
% the excitation's tau1; the second pair ends with tau1 before readout.
function d = slaser_pair(d, H, RF, tp, ph, x, G, tau2, which, tau1)
  d = sim_shapedRF(d, H, RF, tp, 180, ph, x, G);
  d = sim_COF(H, d, 1);
  d = sim_evolve(d, H, tau2 / 1000);
  d = sim_shapedRF(d, H, RF, tp, 180, ph, x, G);
  d = sim_COF(H, d, -1);
  if which == 1
    d = sim_evolve(d, H, tau2 / 1000);
  else
    d = sim_evolve(d, H, tau1 / 1000);
  end
end
