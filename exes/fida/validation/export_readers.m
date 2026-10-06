function export_readers(fida, data, outdir, only)
% EXPORT_READERS  Export FID-A reader results for the Rust reader tests.
%   export_readers(FIDA, DATA, OUTDIR) runs FID-A (the Octave-patched copy
%   at FIDA, see README.md) on every input under DATA (the FIDA_TEST_DATA
%   layout, see README.md) and writes OUTDIR/<case>.json + .bin with
%   export_fida. A water reference returned by the reader is written as
%   <case>_wref. export_readers(..., ONLY) runs the cases whose name
%   contains ONLY. Missing inputs are skipped; reader errors are printed.
  if nargin < 4, only = ''; end
  warning('off', 'all');
  addpath(genpath(fida));
  here = fileparts(mfilename('fullpath'));
  addpath(fullfile(here, 'octave-shims'));
  addpath(here);
  if ~exist(outdir, 'dir'), mkdir(outdir); end
  cases = {
    'twix_megapress',   'twix',  'Siemens/sample01_megapress/megapress/megapressDLPFC.dat'
    'twix_megapress_w', 'twix',  'Siemens/sample01_megapress/megapress_w/megapressDLPFC_w.dat'
    'twix_special',     'twix',  'Siemens/sample02_special/special/specialDLPFC.dat'
    'twix_special_w',   'twix',  'Siemens/sample02_special/special_w/specialDLPFC_w.dat'
    'twixvd_megapress', 'twix',  'SiemensVD/megapress_vd.dat'
    'twixvd_special_w', 'twix',  'SiemensVD/special_w_vd.dat'
    'ge_press',      'ge1',   'GE/sample01_press/press/P17920.7'
    'ge_megapress',     'ge2',   'GE/sample02_megapress/megapress/P21504.7'
    'bruker_press',     'bruk',  'Bruker/sample01_press/press'
    'bruker_press_w',   'bruk',  'Bruker/sample01_press/press_w'
    'bruker_press_n',   'brukn', 'Bruker/sample01_press/press'
    'sdat_ws',          'sdat',  'Philips/philips_spar_sdat_WS.SDAT'
    'sdat_w',           'sdat',  'Philips/philips_spar_sdat_W.SDAT'
  };
  extra = {'SiemensSeq', '*.dat', 'twix'; 'NIfTI-MRS', '*.nii.gz', 'nii'; 'NIfTI-MRS', '*.nii', 'nii'; 'RDA', '*.rda', 'rda'; 'LCModel', '*.RAW', 'lcm'; 'LCModel', '*.H2O', 'lcm'};
  for e = 1:size(extra, 1)
    d = dir(fullfile(data, extra{e, 1}, extra{e, 2}));
    for k = 1:numel(d)
      % case name: kind + file name with every non-alphanumeric as '_'
      % (twix: the name without .dat, as tests/twix.rs expects)
      stem = d(k).name;
      if strcmp(extra{e, 3}, 'twix'), stem = stem(1:end-4); end
      cases(end+1, :) = {[extra{e, 3} '_' regexprep(stem, '[^A-Za-z0-9]', '_')], extra{e, 3}, fullfile(extra{e, 1}, d(k).name)};
    end
  end
  for k = 1:size(cases, 1)
    name = cases{k, 1};
    kind = cases{k, 2};
    p = fullfile(data, cases{k, 3});
    if ~isempty(only) && isempty(strfind(name, only)), continue; end
    if ~exist(p, 'file'), printf('skip %s (no %s)\n', name, p); continue; end
    try
      tic;
      w = [];
      switch kind
        case 'twix', [o, w] = io_loadspec_twix(p);
        case 'ge1', [o, w] = io_loadspec_GE(p, 1);
        case 'ge2', [o, w] = io_loadspec_GE(p, 2);
        case 'bruk', [o, w] = io_loadspec_bruk(p, 'y');
        case 'brukn', [o, w] = io_loadspec_bruk(p, 'n');
        case 'sdat', o = io_loadspec_sdat(p, 1);
        case 'nii', o = io_loadspec_niimrs(p);
        case 'rda', o = io_loadspec_rda(p);
        case 'lcm', o = io_readlcmraw(p, 'dat');
      end
      export_one(o, fullfile(outdir, name));
      if isstruct(w) && isfield(w, 'fids'), export_one(w, fullfile(outdir, [name '_wref'])); end
      printf('ok %s %.1fs sz=%s\n', name, toc, mat2str(o.sz));
    catch err
      % record the failure: the tests then require the Rust reader to fail too
      printf('FAIL %s: %s\n', name, err.message);
      f = fopen(fullfile(outdir, 'FAILED'), 'a');
      fprintf(f, '%s\n', name);
      fclose(f);
    end
  end
end

function export_one(o, path)
  % Readers that store text in numeric header fields (io_loadspec_rda's
  % 'N/A' and 'na') are exported as null with the text beside them.
  for f = {'pointsToLeftshift', 'rawSubspecs'}
    if isfield(o, f{1}) && ischar(o.(f{1}))
      o.([f{1} '_text']) = o.(f{1});
      o.(f{1}) = NaN;
    end
  end
  if isfield(o, 'seq') && iscell(o.seq), o.seq = o.seq{1}; end
  export_fida(o, path);
end
