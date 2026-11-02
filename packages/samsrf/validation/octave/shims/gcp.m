function pool = gcp(varargin)
% gcp  No-op stand-in for the Parallel Computing Toolbox's gcp.
%
% samsrf_prfoptim_loop, samsrf_revcorprf_loop and samsrf_cfparam_loop call gcp inside
% try/catch and call samsrf_error (a fatal error) when it fails, so SamSrf's fine fits
% need the toolbox in MATLAB. Octave has no gcp; this returns an empty pool. The next
% call, parallel.pool.DataQueue, still fails in Octave and is caught by SamSrf, which
% then runs without progress reports. parfor runs as a plain for loop in Octave.

pool = [];
end
