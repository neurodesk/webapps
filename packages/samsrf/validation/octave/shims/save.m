function save(varargin)
% save  Octave's save with MATLAB's '-v7.3' flag mapped to Octave's '-binary' format.
%
% samsrf_fit_prf, samsrf_revcor_prf and samsrf_revcor_cf save their search space,
% regressors and results with save(..., '-v7.3'), the HDF5-based MAT format, which
% Octave 9.2 does not write ("Matlab file format -v7.3 is not yet implemented").
% Octave cannot write function handles (Model.Prf_Function) to a MAT 5 ('-v7') file
% either, so the flag becomes '-binary', Octave's own lossless format, which Octave's
% load reads back with every variable and handle. The built-in save runs in the
% caller's workspace, so it sees the caller's variables. Every other call passes
% through unchanged. Like Octave's own save, a name without an extension is written
% as given (MATLAB would append .mat).

args = varargin;
args(strcmp(args, '-v7.3')) = {'-binary'};
quoted = cellfun(@(a) ['''' strrep(a, '''', '''''') ''''], args, 'UniformOutput', false);
evalin('caller', ['builtin(''save'', ' strjoin(quoted, ', ') ');']);
end
