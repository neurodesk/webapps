% sim_megapress_central.m
% MEGA-PRESS edit-ON and edit-OFF spectra of one spin system with FID-A's
% shaped-pulse simulation at the voxel centre, summed over FID-A's 16-step
% phase cycle of the editing and refocusing pulses as run_simMegaPressShaped.m
% does (the cycle removes unrefocused coherences that crusher gradients
% remove in the scanner). Derived from FID-A's run_simMegaPressShaped.m and
% sim_megapress_shaped.m, Copyright 2014-2020 Jamie Near, BSD-3-Clause: the
% pulse sequence is sim_megapress_shaped's, but the phase cycle is summed on
% the density matrix and read out once, because FID-A's readout (8192
% points) costs more than the pulses and is linear in the density matrix.
% Only the centre position is simulated: slice-profile effects across the
% voxel are not included. The result is re-centred to 4.65 ppm at 0 Hz
% (FID-A's shaped simulation centres at 3.0 ppm), the convention of the rest
% of the basis library.
%
% [on, off] = sim_megapress_central(set, sys)
function [on, off] = sim_megapress_central(set, sys)
  gamma = 42577000;
  centreFreq = 3.0;
  refRF = rf_resample(io_loadRFwaveform('sampleRefocPulse.pta', 'ref', 0), 100);
  editRF = io_loadRFwaveform('sampleEditPulse.pta', 'inv', 0);
  editRFon = rf_freqshift(editRF, set.edit_tp_ms, (centreFreq - set.edit_on_ppm) * set.field_T * gamma / 1e6);
  editRFoff = rf_freqshift(editRF, set.edit_tp_ms, (centreFreq - set.edit_off_ppm) * set.field_T * gamma / 1e6);
  thk = 3;
  G = (refRF.tbw / (set.refoc_tp_ms / 1000)) / (gamma * thk / 10000);
  for k = 1:numel(sys)
    sys(k).shifts = sys(k).shifts - centreFreq;
  end
  [H, d0] = sim_Hamiltonian(sys, set.field_T);
  d0 = sim_excite(d0, H, 'x');
  ph = [0 90];
  dOn = [];
  dOff = [];
  for EP1 = 1:2
    for EP2 = 1:2
      for RP1 = 1:2
        for RP2 = 1:2
          % run_simMegaPressShaped: ([0 0] - [0 90]) - ([90 0] - [90 90]).
          sign = 1 - 2 * xor(RP1 == 2, RP2 == 2);
          p = [ph(RP1) ph(EP1) ph(RP2) ph(EP2)];
          dOn = sim_dAdd(dOn, mega(d0, H, set, editRFon, refRF, G, p), sign);
          dOff = sim_dAdd(dOff, mega(d0, H, set, editRFoff, refRF, G, p), sign);
        end
      end
    end
  end
  on = readout(dOn, H, set, centreFreq);
  off = readout(dOff, H, set, centreFreq);
end

% sim_megapress_shaped's sequence up to the readout, at the voxel centre.
% p = [refocusing 1, editing 1, refocusing 2, editing 2] phases.
function d = mega(d, H, set, editRF, refRF, G, p)
  taus = set.taus_ms(:)';
  refTp = set.refoc_tp_ms;
  editTp = set.edit_tp_ms;
  delays = [taus(1) - refTp / 2, taus(2) - (refTp + editTp) / 2, taus(3) - (editTp + refTp) / 2, ...
            taus(4) - (refTp + editTp) / 2, taus(5) - editTp / 2];
  if any(delays < 0), error('taus too short: %s', num2str(find(delays < 0))); end
  d = sim_evolve(d, H, delays(1) / 1000);
  d = sim_shapedRF(d, H, refRF, refTp, 180, 90 + p(1), 0, G);
  d = sim_evolve(d, H, delays(2) / 1000);
  d = sim_shapedRF(d, H, editRF, editTp, 180, 90 + p(2));
  d = sim_evolve(d, H, delays(3) / 1000);
  d = sim_shapedRF(d, H, refRF, refTp, 180, 90 + p(3), 0, G);
  d = sim_evolve(d, H, delays(4) / 1000);
  d = sim_shapedRF(d, H, editRF, editTp, 180, 90 + p(4));
  d = sim_evolve(d, H, delays(5) / 1000);
end

function out = readout(d, H, set, centreFreq)
  gamma = 42577000;
  [out, ~] = sim_readout(d, H, set.points, set.bandwidth_Hz, set.linewidth_Hz, 90);
  out = op_ampScale(fida_fields(out, set), 1 / 16);
  out.ppm = out.ppm - (4.65 - centreFreq);
  out = op_freqshift(out, (4.65 - centreFreq) * set.field_T * gamma / 1e6);
  out.ppm = out.ppm + (4.65 - centreFreq);
end

% The header fields FID-A's processing functions expect.
function out = fida_fields(out, set)
  out.seq = 'megapress';
  out.te = set.te_ms;
  out.sim = 'shaped';
  out.sz = size(out.specs);
  out.dims.t = 1; out.dims.coils = 0; out.dims.averages = 0; out.dims.subSpecs = 0; out.dims.extras = 0;
  out.averages = 1; out.rawAverages = 1; out.subspecs = 1; out.rawSubspecs = 1;
  out.flags.writtentostruct = 1; out.flags.gotparams = 1; out.flags.leftshifted = 0; out.flags.filtered = 0;
  out.flags.zeropadded = 0; out.flags.freqcorrected = 0; out.flags.phasecorrected = 0; out.flags.averaged = 1;
  out.flags.addedrcvrs = 1; out.flags.subtracted = 1; out.flags.writtentotext = 0; out.flags.downsampled = 0;
  out.flags.isFourSteps = 0;
end
