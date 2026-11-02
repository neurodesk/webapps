function analyses(example_dir, out_dir, samsrf_dir)
% analyses  Runs SamSrf's three analyses on X001 in Octave and writes their maps.
%
% analyses(example_dir, out_dir, samsrf_dir)
%
% Runs samsrf_fit_prf, samsrf_revcor_prf and samsrf_revcor_cf, SamSrf's own code, with
% the shims on the path, from <out_dir>/analyses (the analyses save their search space,
% regressors and map files into the working directory). Expects the GIFTI run sidecars
% under <out_dir>/gifti, the Benson sidecar under <out_dir>/analyses/gifti, and
% labels/roi_full.label, labels/seed_v1.label and apertures/aps_Bars.mat under
% <out_dir>/analyses (run.sh prepares all of them). The environment variable
% SAMSRF_ANALYSES, a comma-separated list of run names, restricts the runs. SamSrf's
% code runs unpatched: when an analysis errors, <run>.json records the error instead of
% the maps.
% README.md ("Analyses") lists every file written.

t0 = tic;
save_default_options('-v7');
more off;
adir = fullfile(out_dir, 'analyses');
cd(adir);
delete_if_present('src_pRF_Gaussian.mat');
delete_if_present('reg_aps_Bars.mat');

Srf = functional_srf(example_dir, out_dir);
template_section(example_dir, adir);
subsets = subsets_section(Srf);
georoi_section(Srf, cell2mat(subsets.seed));
convexhull_section();

prf = prf_model(samsrf_dir);
rc = rc_model(samsrf_dir);
cf = struct('Name', 'CF_Rcp', 'SeedRoi', 'labels/seed_v1', 'Template', 'template/lh_benson');
runs = {
    'prf_coarse', 'prf', setfield(prf, 'Coarse_Fit_Only', 1), 'labels/roi_full';
    'prf_nm', 'prf', prf, 'labels/roi_fine';
    'prf_hj', 'prf', setfield(prf, 'Hooke_Jeeves_Steps', [0.01 0.01 0.01]), 'labels/roi_fine';
    'prf_hrf', 'prf', setfield(prf, 'Hrf', Inf), 'labels/roi_tiny';
    'prf_css', 'prf', setfield(prf, 'Compressive_Nonlinearity', 1), 'labels/roi_tiny';
    'rc_hull', 'rc', rc, 'labels/roi_full';
    'rc_fit', 'rc', rc_fit_model(rc), 'labels/roi_fine';
    'cf_hull', 'cf', cf, 'labels/roi_full';
    'cf_summary', 'cf', setfield(cf, 'Fit_pRF', -1), 'labels/roi_full';
    'cf_fit', 'cf', setfield(cf, 'Fit_pRF', 1), 'labels/roi_tiny';
    'cf_smooth', 'cf', setfield(cf, 'Smoothing', 3), 'labels/roi_fine';
};
selected = getenv('SAMSRF_ANALYSES');
if ~isempty(selected)
    selected = strsplit(selected, ',');
end
for i = 1:size(runs, 1)
    if ~isempty(selected) && ~any(strcmp(selected, runs{i, 1}))
        continue;
    end
    run_analysis(runs{i, :}, Srf);
    % SamSrf ends its warning-off blocks with "warning on", which also enables these.
    warning('off', 'Octave:mixed-string-concat');
    warning('off', 'Octave:language-extension');
end
printf('analyses.m finished in %.0f s\n', toc(t0));
end

%% The averaged, detrended and z-scored runs plus the white surface, as samsrf_gii2srf with a surf folder
function Srf = functional_srf(example_dir, out_dir)
runs = cell(6, 1);
for i = 1:6
    runs{i} = fullfile(out_dir, 'gifti', sprintf('lh_uBars%d.gii', i));
end
Srf = samsrf_gii2srf(runs, '', 1, true, true);
[V0, F] = fs_read_surf(fullfile(example_dir, 'surf', 'lh.white'));
A = fs_read_curv(fullfile(example_dir, 'surf', 'lh.area'));
Srf.Vertices = V0;
Srf.Faces = F;
Srf.Area = A';
Srf.Hemisphere = 'lh';
end

%% Benson template, as samsrf_benson2srf builds it
function template_section(example_dir, adir)
D = gifti(fullfile(adir, 'gifti', 'lh_benson.gii'));
D = D.cdata;
D(:, 1) = -D(:, 1) + 90;
x0 = D(:, 2) .* cos(D(:, 1) / 180 * pi);
y0 = D(:, 2) .* sin(D(:, 1) / 180 * pi);
rois = D(:, 3);
[V0, F] = fs_read_surf(fullfile(example_dir, 'surf', 'lh.white'));
Srf = struct;
Srf.Version = samsrf_version;
Srf.Structural = 'surf';
Srf.Functional = 'benson';
Srf.Hemisphere = 'lh';
Srf.Cortex_Steps = NaN;
Srf.Vertices = V0;
Srf.Faces = F;
Srf.Data = NaN(5, size(V0, 1));
Srf.Data(1, :) = zeros(1, size(V0, 1));
Srf.Data(1, rois ~= 0) = ones(1, sum(rois ~= 0));
Srf.Data(2, :) = x0';
Srf.Data(3, :) = y0';
Srf.Data(5, :) = rois';
Srf.Rule = 'X';
Srf.Values = {'R^2'; 'x0'; 'y0'; 'Sigma'; 'ROI'};
if ~exist('template', 'dir')
    mkdir('template');
end
save('template/lh_benson.mat', 'Srf', '-v7');
write_f64('template_data.f64', Srf.Data);
info.values = Srf.Values;
info.shape = size(Srf.Data);
info.source = 'benson/lh_benson.gii';
info.class_of_cdata = 'single';
write_json('template.json', info);
end

%% Vertex subsets, written as FreeSurfer labels
function subsets = subsets_section(Srf)
[roi, xyz] = read_label('labels/roi_full.label');
seed = read_label('labels/seed_v1.label');
ceiling = Srf.Noise_Ceiling(roi + 1);
ceiling(isnan(ceiling)) = -Inf;
[~, order] = sort(ceiling, 'descend');
top = order(1:100);
rest = setdiff(1:numel(roi), top);
rand('state', 1);
pick = randperm(numel(rest));
fine = sort([top(:); rest(pick(1:100))']);
tiny = sort(order(1:20));
write_label('labels/roi_fine.label', 'roi_fine: the 100 highest-noise-ceiling roi_full vertices and 100 others', roi(fine), xyz(fine, :));
write_label('labels/roi_tiny.label', 'roi_tiny: the 20 highest-noise-ceiling roi_full vertices', roi(tiny), xyz(tiny, :));
subsets.roi_fine = as_list(roi(fine));
subsets.roi_tiny = as_list(roi(tiny));
subsets.seed = as_list(seed);
subsets.roi_full = as_list(roi);
write_json('subsets.json', subsets);
end

function [index, xyz] = read_label(path)
fid = fopen(path, 'r');
fgetl(fid);
count = str2double(fgetl(fid));
values = fscanf(fid, '%f');
fclose(fid);
values = reshape(values, numel(values) / count, count)';
index = values(:, 1);
xyz = values(:, 2:4);
end

function write_label(path, comment, index, xyz)
fid = fopen(path, 'w');
fprintf(fid, '#!ascii label, %s\n%d\n', comment, numel(index));
for i = 1:numel(index)
    fprintf(fid, '%d  %.3f  %.3f  %.3f 0\n', index(i), xyz(i, 1), xyz(i, 2), xyz(i, 3));
end
fclose(fid);
end

%% samsrf_georoi on the first three seed vertices
function georoi_section(Srf, seed)
entries = {};
for i = 1:3
    [Vs, Ds] = samsrf_georoi(seed(i) + 1, 20, Srf.Vertices, Srf.Faces);
    entry.vertex = seed(i);
    entry.steps = 20;
    entry.vs = as_list(Vs - 1);
    entry.ds = as_list(Ds);
    entries{end + 1} = entry;
end
write_json('georoi.json', struct('cases', {entries}));
end

%% The positive-subfield geometry of samsrf_cfparam_loop's convex hull branch, in isolation
function convexhull_section()
[gx, gy] = meshgrid(-2:2, -2:2);
grid = [gx(:) gy(:)];
ring = double(max(abs(grid), [], 2) == 2);
ell = double(grid(:, 1) == -2 | grid(:, 2) == -2);
[bx, by] = meshgrid(0:5, 0:5);
blobs = [bx(:) by(:)];
cases = {
    'gaussian_5x5', grid, exp(-((grid(:, 1) - 0.5) .^ 2 + grid(:, 2) .^ 2) / 2);
    'square_with_hole', grid, ring;
    'l_shape', grid, ell;
    'two_blobs_6x6', blobs, exp(-sum((blobs - [1 1]) .^ 2, 2) / 3) + 0.8 * exp(-sum((blobs - [4 4]) .^ 2, 2) / 3);
    'collinear_3', [0 0; 1 1; 2 2], [1; 2; 1];
    'two_points', [0 0; 1 0], [1; 2];
};
entries = {};
for i = 1:size(cases, 1)
    entries{end + 1} = hull_case(cases{i, :});
end
write_json('convexhull_cases.json', struct('cases', {entries}));
end

function c = hull_case(name, points, statistic)
% The lines of samsrf_cfparam_loop's positive subfield, with R = statistic.
txy = double(points);
R = statistic;
[txy, u] = unique(txy, 'rows');
R = R(u);
mR = max(R);
state = warning();
warning off
tri = delaunay(txy);
pos = samsrf_clusterroi(find(R == mR, 1), R, mR / 2, tri);
ps = polyshape(txy(pos, :));
ps = ps.convhull;
cha = ps.area;
[chx, chy] = ps.centroid;
warning(state);
c.name = name;
c.points = points;
c.statistic = statistic';
c.unique_points = txy;
c.unique_order = as_list(u - 1);
c.unique_statistic = R';
c.threshold = mR / 2;
c.triangles = tri - 1;
c.pos = as_list(pos - 1);
c.area = cha;
c.centroid = {json_number(chx), json_number(chy)};
end

%% Models
function Model = load_model(samsrf_dir, name)
% LoadModelJson's result without readstruct (absent in Octave): numeric arrays as rows,
% Prf_Function and SeedPar_Function through str2func, Param_Names as a cellstr.
Model = jsondecode(fileread(fullfile(samsrf_dir, 'Models', 'Json', [name '.json'])));
fields = fieldnames(Model);
for i = 1:numel(fields)
    value = Model.(fields{i});
    if isnumeric(value)
        Model.(fields{i}) = value(:)';
    end
end
if isfield(Model, 'Prf_Function')
    Model.Prf_Function = str2func(Model.Prf_Function);
end
if isfield(Model, 'SeedPar_Function')
    Model.SeedPar_Function = str2func(Model.SeedPar_Function);
end
if isfield(Model, 'Param_Names')
    Model.Param_Names = cellstr(Model.Param_Names)';
end
end

function Model = prf_model(samsrf_dir)
Model = load_model(samsrf_dir, 'Example_2D_Gaussian_pRF');
Model.Aperture_File = 'apertures/aps_Bars';
end

function Model = rc_model(samsrf_dir)
Model = load_model(samsrf_dir, 'Example_Reverse_Correlation_pRF');
Model.Aperture_File = 'apertures/aps_Bars';
end

function Model = rc_fit_model(Model)
Model.Prf_Function = @(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth);
Model.Param_Names = {'x0', 'y0', 'Sigma'};
Model.Scaled_Param = [1 1 1];
Model.SeedPar_Function = @(V) [V(2:3); V(4)/(2*sqrt(2*log(2)))];
Model.R2_Threshold = 0.1;
end

%% One analysis: run it, load the map file it saved, expand it and dump it
function run_analysis(name, analysis, Model, roi, Srf)
printf('\n===== %s (%s, %s) =====\n', name, analysis, roi);
out_files = {'lh_pRF_Gaussian', 'lh_pRF_Gaussian_CrsFit', 'lh_pRF_Gaussian_Css', 'lh_pRF_Rcp', 'lh_CF_Rcp'};
for i = 1:numel(out_files)
    delete_if_present(out_files{i});
    delete_if_present([out_files{i} '.mat']);
end
started = tic;
try
    switch analysis
        case 'prf'
            OutFile = samsrf_fit_prf(Model, Srf, roi);
        case 'rc'
            OutFile = samsrf_revcor_prf(Model, Srf, roi);
        case 'cf'
            OutFile = samsrf_revcor_cf(Model, Srf, roi);
    end
catch err
    write_error(name, analysis, Model, roi, err, toc(started));
    return;
end
seconds = toc(started);
saved = load(OutFile);
Out = samsrf_expand_srf(saved.Srf);

info.name = name;
info.analysis = analysis;
info.model = json_value(saved.Model);
info.roi_label = [roi '.label'];
if strcmp(analysis, 'cf')
    info.seed_label = [Model.SeedRoi '.label'];
else
    info.seed_label = NaN;
end
info.out_file = OutFile;
info.values = Out.Values(:)';
if isfield(Out, 'Raw_Values')
    info.raw_values = Out.Raw_Values(:)';
else
    info.raw_values = NaN;
end
info.rows = size(Out.Data, 1);
info.vertices = size(Out.Data, 2);
info.mver = as_list(samsrf_loadlabel(roi) - 1);
info.data_file = [name '_data.f64'];
write_f64(info.data_file, Out.Data);
if isfield(Out, 'Raw_Data')
    info.raw_rows = size(Out.Raw_Data, 1);
    info.raw_file = [name '_raw.f64'];
    write_f64(info.raw_file, Out.Raw_Data);
else
    info.raw_rows = NaN;
    info.raw_file = NaN;
end
info.seconds = seconds;
% jsonencode writes NaN as null: seed_label, raw_values, raw_rows and raw_file are
% NaN when the analysis has none.
write_json([name '.json'], info);
movefile(output_name(OutFile), [name '_' output_name(OutFile)]);
printf('%s: %d x %d in %.0f s\n', name, info.rows, info.vertices, seconds);
end

function write_error(name, analysis, Model, roi, err, seconds)
% The analysis failed inside SamSrf: record the message and where it was raised.
info.name = name;
info.analysis = analysis;
info.model = json_value(Model);
info.roi_label = [roi '.label'];
if strcmp(analysis, 'cf')
    info.seed_label = [Model.SeedRoi '.label'];
else
    info.seed_label = NaN;
end
info.error = err.message;
info.error_identifier = err.identifier;
info.error_stack = arrayfun(@(f) sprintf('%s at line %d', f.name, f.line), err.stack(:)', 'UniformOutput', false);
info.seconds = seconds;
write_json([name '.json'], info);
printf('%s: FAILED in SamSrf after %.0f s: %s\n', name, seconds, err.message);
end

function name = output_name(OutFile)
name = OutFile;
if ~exist(name, 'file')
    name = [OutFile '.mat'];
end
end

%% Output helpers
function v = json_value(v)
% Function handles become func2str strings, non-finite numbers the strings "Inf",
% "-Inf" and "NaN" (as json_number does for scalars), everything else is kept.
if isa(v, 'function_handle')
    v = func2str(v);
elseif isstruct(v)
    fields = fieldnames(v);
    for i = 1:numel(fields)
        v.(fields{i}) = json_value(v.(fields{i}));
    end
elseif iscell(v)
    v = cellfun(@json_value, v, 'UniformOutput', false);
elseif (isnumeric(v) || islogical(v)) && ~all(isfinite(v(:)))
    if isscalar(v)
        v = json_number(v);
    else
        v = arrayfun(@json_number, double(v), 'UniformOutput', false);
    end
end
end

function c = as_list(v)
% A JSON array even for one element (jsonencode writes a 1 x 1 matrix as a scalar).
c = num2cell(double(v(:)'));
end

function delete_if_present(path)
if exist(path, 'file')
    delete(path);
end
end

function write_f64(path, A)
fid = fopen(path, 'w');
fwrite(fid, A, 'double', 0, 'ieee-le');
fclose(fid);
end

function write_json(path, value)
fid = fopen(path, 'w');
fprintf(fid, '%s\n', jsonencode(value, 'PrettyPrint', true));
fclose(fid);
end

function v = json_number(v)
if ~isfinite(v)
    v = num2str(v);
end
end
