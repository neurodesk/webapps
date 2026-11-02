function save(varargin)
% save  Octave's save with MATLAB's '-v7.3' flag mapped to '-v7'.
%
% samsrf_fit_prf, samsrf_revcor_prf and samsrf_revcor_cf save their search space,
% regressors and results with save(..., '-v7.3'), the HDF5-based MAT format, which
% Octave 9.2 does not write ("Matlab file format -v7.3 is not yet implemented").
% This replaces the flag with '-v7' (the same variables, zlib-compressed MAT 5) and
% runs the built-in save in the caller's workspace, so it sees the caller's variables.
% Every other call passes through unchanged. Like Octave's own save, a name without an
% extension is written as given (MATLAB would append .mat).

args = varargin;
args(strcmp(args, '-v7.3')) = {'-v7'};
quoted = cellfun(@(a) ['''' strrep(a, '''', '''''') ''''], args, 'UniformOutput', false);
evalin('caller', ['builtin(''save'', ' strjoin(quoted, ', ') ');']);
end
