function spm(varargin)
% spm  Empty stand-in so exist('spm', 'file') is true in samsrf_gii2srf.
%
% samsrf_gii2srf refuses to read GIFTI files unless SPM is on the path; the
% actual reading goes through the gifti shim next to this file.
end
