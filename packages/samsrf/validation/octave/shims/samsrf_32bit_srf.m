function Srf = samsrf_32bit_srf(Srf)
% samsrf_32bit_srf  Identity: the reference run keeps every Srf field in double.
%
% SamSrf's own version converts every double field to single unconditionally,
% because its guard exist('SamSrfDefs.defs_64bit', 'var') tests a variable name
% that never exists. The Rust port computes in f64, so the reference stays in
% double; this also removes the need for SamSrf_defaults.json on the path.
end
