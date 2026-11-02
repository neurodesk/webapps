function tf = verLessThan(toolbox, version)
% verLessThan  Stand-in that reports a current MATLAB for verLessThan('matlab', ...).
%
% samsrf_fit_prf calls verLessThan('matlab', '7.13') to choose between one vertex per
% coarse-fit block (MATLAB before R2012a) and Model.Coarse_Fit_Block_Size. Octave's
% verLessThan errors because no package is called "matlab". Every MATLAB release
% SamSrf 10 supports is newer than 7.13, so this returns false. Any other toolbox
% name errors, since SamSrf asks for none.

if ~strcmpi(toolbox, 'matlab')
    error('verLessThan shim: only ''matlab'' is supported, not ''%s'' (%s)', toolbox, version);
end
tf = false;
end
