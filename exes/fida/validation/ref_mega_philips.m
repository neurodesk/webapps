% REF_MEGA_PHILIPS  FID-A reference for Philips MEGA-PRESS (megapressproc_det).
%   PHILIPS_MEGA=dir FIDA_TEST_DATA=... octave-cli ref_mega_philips.m
%   (writes ops/philips_mega). The data are Osprey's MIT example
%   exampledata/sdat/MEGA/sub-01 (sub-01_megapress_{act,ref}.{sdat,spar}).
%   FID-A splits alternate rows into edit-OFF and edit-ON (subspecs = 2);
%   these data already have FID-A's layout, so the app's classification
%   (src/ops/editing.rs) leaves them as they are. The water reference holds
%   8 transients in 320 rows; the zero rows are dropped, as the app does.
root = fida_setup();
pd = getenv('PHILIPS_MEGA');
raw = io_loadspec_sdat(fullfile(pd, 'sub-01_megapress_act.sdat'), 2);
raww = io_loadspec_sdat(fullfile(pd, 'sub-01_megapress_ref.sdat'), 1);
keep = find(max(abs(raww.fids), [], 1) > 1e-12 * max(abs(raww.fids(:))));
raww = op_takeaverages(raww, keep);
printf('water: %d of %d transients kept\n', numel(keep), raww.rawAverages);
d = fullfile(root, 'philips_mega');
mkdir(d);
export_fida(raw, fullfile(d, 'raw'));
export_fida(raww, fullfile(d, 'raww'));
tic;
[diffSpec, sumSpec, sub1, sub2, outw] = megapressproc_det(raw, raww, d);
printf('MEGA-PRESS pipeline: %.1f s\n', toc);
