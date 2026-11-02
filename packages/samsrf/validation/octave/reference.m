function reference(example_dir, out_dir, samsrf_dir)
% reference  Runs SamSrf's MATLAB sources in Octave and writes the parity reference outputs.
%
% reference(example_dir, out_dir, samsrf_dir)
%
% Expects the shims and the SamSrf folders on the path (run.sh does this), the GIFTI
% sidecars under <out_dir>/gifti, preprocess_vertices.json in <out_dir> and a copy of
% aps_Bars.mat under <out_dir>/apertures. README.md lists every file written.

t0 = tic;
save_default_options('-v7');
more off;
aps = apertures_section(example_dir, out_dir);
hrf_section(example_dir, out_dir);
profiles_section(out_dir, aps.xy_scaled);
expr_section(out_dir, samsrf_dir);
rosenbrock_section(out_dir);
preprocess_section(out_dir, aps);
printf('reference.m finished in %.0f s\n', toc(t0));
end

%% Apertures: the real VectoriseApertures on a copy of aps_Bars.mat
function aps = apertures_section(example_dir, out_dir)
aps_file = fullfile(out_dir, 'apertures', 'aps_Bars');
original = load([aps_file '.mat']);
VectoriseApertures(aps_file);
vec_file = [aps_file '_vec.mat'];
if ~exist(vec_file, 'file')
    vec_file = [aps_file '_vec'];
end
vec = load(vec_file);
scaling_factor = 9.5;
aps.ap_frm = vec.ApFrm;
aps.ap_xy = vec.ApXY;
aps.xy_scaled = vec.ApXY / max(abs(vec.ApXY(:))) * scaling_factor;
write_f64(fullfile(out_dir, 'apertures_apfrm.f64'), aps.ap_frm);
write_f64(fullfile(out_dir, 'apertures_apxy.f64'), aps.ap_xy);
write_f64(fullfile(out_dir, 'apertures_apxy_scaled.f64'), aps.xy_scaled);
info.height = size(original.ApFrm, 1);
info.width = size(original.ApFrm, 2);
info.volumes = size(original.ApFrm, 3);
info.pixels = size(vec.ApFrm, 1);
info.apfrm_shape = size(vec.ApFrm);
info.apxy_shape = size(vec.ApXY);
info.apxy_max_abs = max(abs(vec.ApXY(:)));
info.scaling_factor = scaling_factor;
info.source = 'prf/aps_Bars.mat';
write_json(fullfile(out_dir, 'apertures.json'), info);
end

%% HRFs: every kernel form samsrf_fit_prf can build, and prf_convolve_hrf on a test sequence
function hrf_section(example_dir, out_dir)
fit = load(fullfile(example_dir, 'prf', 'hrf_fit.mat'));
fP = double(fit.fP);
Y = mod((1:50)', 7) - 3;
nondefault = [5 15 1.2 0.9 5 1 30];
entries = {};
for TR = [1 2.55]
    kernels = struct();
    kernels.doublegamma_default = samsrf_doublegamma(TR);
    kernels.samsrf_hrf = samsrf_hrf(TR);
    kernels.old_school = samsrf_doublegamma(TR, [fP(1:2) 1 1 fP(3) 0 32])' * fP(4);
    kernels.doublegamma_nondefault = samsrf_doublegamma(TR, nondefault);
    names = fieldnames(kernels);
    for i = 1:numel(names)
        kernel = kernels.(names{i});
        entry.tr = TR;
        entry.kernel = names{i};
        entry.shape = size(kernel);
        entry.values = kernel(:)';
        entry.convolve_ds1 = prf_convolve_hrf(Y, kernel, 1)';
        entry.convolve_ds2 = prf_convolve_hrf(Y, kernel, 2)';
        entries{end + 1} = entry;
    end
end
out.fP = fP;
out.nondefault_parameters = nondefault;
out.test_sequence = Y';
out.entries = entries;
out.gampdf_at_zero = {};
for a = [0.5 1 6]
    spot.a = a;
    spot.b = 1;
    spot.value = json_number(gampdf(0, a, 1));
    out.gampdf_at_zero{end + 1} = spot;
end
write_json(fullfile(out_dir, 'hrf.json'), out);
end

%% pRF profile functions on fixed parameter sets, in both branches
function profiles_section(out_dir, xy_scaled)
screen_width = 200;
specs = {
    'prf_gaussian_rf', {[2 1 1.5], [-3 -4 0.05], [0 0 9]}, true;
    'prf_dog_rf', {[1 -2 1 3 0.5], [-4 3 0.1 0.5 1.2], [0 0 2 0.05 -0.3]}, true;
    'prf_multivariate_rf', {[1 2 1 3 45], [-2 -1 0.5 0.1 -30], [3 -3 2 1 400]}, true;
    'prf_sumnorm_rf', {[1 1 2 0.5], [-2 3 0.1 -0.7], [0 -4 1 1.5]}, true;
    'prf_skewgauss_rf', {[1 1 2 1.5 -2], [-3 2 0.05 -0.5 0.5], [0 0 3 0 3]}, true;
    'prf_gaussian_rf_2sigma', {[1 1 1 2], [-2 -3 0.05 0.5], [0 0 3 0.1]}, false;
};
entries = {};
for i = 1:size(specs, 1)
    name = specs{i, 1};
    f = str2func(name);
    for j = 1:numel(specs{i, 2})
        params = specs{i, 2}{j};
        args = num2cell(params);
        entries{end + 1} = profile_entry(out_dir, name, params, 'xy', j, f(args{:}, xy_scaled));
        if specs{i, 3}
            entries{end + 1} = profile_entry(out_dir, name, params, 'grid', j, f(args{:}, screen_width));
        end
    end
end
out.scaling_factor = 9.5;
out.screen_width = screen_width;
out.entries = entries;
write_json(fullfile(out_dir, 'prf_profiles.json'), out);
end

function entry = profile_entry(out_dir, name, params, branch, index, rfp)
entry.function = name;
entry.params = params;
entry.branch = branch;
entry.shape = size(rfp);
entry.file = sprintf('profile_%s_%d_%s.f64', name, index, branch);
entry.nan_count = nnz(isnan(rfp));
write_f64(fullfile(out_dir, entry.file), rfp);
end

%% Model expressions: every Prf_Function and SeedPar_Function string in Models/
function expr_section(out_dir, samsrf_dir)
files = [dir(fullfile(samsrf_dir, 'Models', '*.m')); dir(fullfile(samsrf_dir, 'Models', 'Json', '*.json'))];
sources = {};
kinds = {};
origins = {};
for i = 1:numel(files)
    text = fileread(fullfile(files(i).folder, files(i).name));
    tokens = [regexp(text, '(Prf_Function|SeedPar_Function)\s*=\s*(@[^\n]*)', 'tokens'), ...
              regexp(text, '"(Prf_Function|SeedPar_Function)"\s*:\s*"([^"]*)"', 'tokens')];
    for t = 1:numel(tokens)
        % A .m line ends in ";" and a comment; the SeedPar body itself contains ";".
        source = regexprep(strtrim(tokens{t}{2}), '\s*;\s*(%.*)?$', '');
        k = find(strcmp(sources, source), 1);
        if isempty(k)
            sources{end + 1} = source;
            kinds{end + 1} = tokens{t}{1};
            origins{end + 1} = {files(i).name};
        else
            origins{k}{end + 1} = files(i).name;
        end
    end
end
XY = [-1 -1; 0 0.5; 1 -0.25; 0.3 -0.2; 0.5 0.5; -0.5 0.5];
P = {[0.3 -0.2 0.5 0.9 15], [-1.5 2 2.5 1.5 -40]};
V = {[1; 2; 3; 4], [0.5; -1.5; 2.25; 3.5]};
cases = {};
for i = 1:numel(sources)
    f = str2func(sources{i});
    header = regexp(sources{i}, '^@\(([^)]*)\)', 'tokens', 'once');
    nargs = numel(strsplit(header{1}, ','));
    for k = 1:2
        c.source = sources{i};
        c.kind = kinds{i};
        c.files = origins{i};
        if nargs == 2
            c.inputs.P = P{k};
            c.inputs.XY = XY;
            result = f(P{k}, XY);
        else
            c.inputs.V = V{k}';
            result = f(V{k});
        end
        c.shape = size(result);
        c.values = result(:)';
        cases{end + 1} = c;
    end
end
write_json(fullfile(out_dir, 'expr.json'), struct('cases', {cases}));
end

%% fminsearch shim against MATLAB's documented Rosenbrock example
function rosenbrock_section(out_dir)
banana = @(x) 100 * (x(2) - x(1)^2)^2 + (1 - x(1))^2;
[x, fval, exitflag, output] = fminsearch(banana, [-1.2, 1]);
out.x = x;
out.fval = fval;
out.exitflag = exitflag;
out.iterations = output.iterations;
out.funcCount = output.funcCount;
options = optimset('Display', 'off');
options.OutputFcn = @(x, values, state) values.iteration >= 10;
[x, fval, exitflag, output] = fminsearch(banana, [-1.2, 1], options);
out.stopped_by_outputfcn.x = x;
out.stopped_by_outputfcn.fval = fval;
out.stopped_by_outputfcn.exitflag = exitflag;
out.stopped_by_outputfcn.iterations = output.iterations;
out.stopped_by_outputfcn.funcCount = output.funcCount;
write_json(fullfile(out_dir, 'fminsearch_rosenbrock.json'), out);
end

%% Preprocessing through the real samsrf_gii2srf, the global signal and samsrf_removenoise
function preprocess_section(out_dir, aps)
vertices = jsondecode(fileread(fullfile(out_dir, 'preprocess_vertices.json')));
subset = vertices.subset(:)' + 1;
roi = vertices.roi(:)' + 1;
runs = cell(6, 1);
for i = 1:6
    runs{i} = fullfile(out_dir, 'gifti', sprintf('lh_uBars%d.gii', i));
end

Srf = samsrf_gii2srf(runs, '', 1, true, true);
manifest.volumes_per_run = size(Srf.Data, 1);
manifest.vertices = size(Srf.Data, 2);
manifest.runs = numel(runs);
manifest.subset_count = numel(subset);
write_f64(fullfile(out_dir, 'preprocess_average.f64'), Srf.Data(:, subset));
write_f64(fullfile(out_dir, 'preprocess_noise_ceiling.f64'), Srf.Noise_Ceiling(subset));
global_signal = nanmean(Srf.Data, 2);
write_f64(fullfile(out_dir, 'global_signal_average.f64'), global_signal);
cSrf = samsrf_removenoise(Srf, global_signal, subset);
write_f64(fullfile(out_dir, 'preprocess_removenoise.f64'), cSrf.Data(:, subset));
clear cSrf;
manifest.noise_ceiling_finite = nnz(isfinite(Srf.Noise_Ceiling(subset)));
manifest.errfun_vertices = errfun_section(out_dir, aps, Srf, roi);
clear Srf;

Srf = samsrf_gii2srf(runs, '', 1, false, true);
manifest.concat_volumes = size(Srf.Data, 1);
write_f64(fullfile(out_dir, 'preprocess_concat.f64'), Srf.Data(:, subset));
write_f64(fullfile(out_dir, 'global_signal_concat.f64'), nanmean(Srf.Data, 2));
clear Srf;

Srf = samsrf_gii2srf(runs(1), '', -1, true, true);
write_f64(fullfile(out_dir, 'preprocess_detrend_run1.f64'), Srf.Data(:, subset));
clear Srf;
write_json(fullfile(out_dir, 'preprocess.json'), manifest);
end

%% prf_errfun on averaged time courses of the three ROI vertices with the highest noise ceiling
function picks = errfun_section(out_dir, aps, Srf, roi)
ceiling = Srf.Noise_Ceiling(roi);
ceiling(isnan(ceiling)) = -Inf;
[~, order] = sort(ceiling, 'descend');
picks = roi(order(1:3)) - 1;
source = '@(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth)';
PrfFcn = str2func(source);
Hrf = samsrf_doublegamma(1);
P = {[2 1 1.5], [-3 -4 0.5], [0.5 0.5 5]};
cases = {};
for v = 1:3
    Y = Srf.Data(:, picks(v) + 1);
    for k = 1:3
        cases{end + 1} = errfun_case(picks(v), P{k}, 'samsrf_doublegamma(1)', false, prf_errfun(PrfFcn, aps.ap_frm, aps.xy_scaled, Hrf, P{k}, Y, 1, false));
    end
end
Y = Srf.Data(:, picks(1) + 1);
css = [2 1 1.5 0.5];
cases{end + 1} = errfun_case(picks(1), css, 'samsrf_doublegamma(1)', true, prf_errfun(PrfFcn, aps.ap_frm, aps.xy_scaled, Hrf, css, Y, 1, true));
fit = [2 1 1.5 6 16 1 1 6];
cases{end + 1} = errfun_case(picks(1), fit, -1, false, prf_errfun(PrfFcn, aps.ap_frm, aps.xy_scaled, -1, fit, Y, 1, false));
outside = [2 1 1.5 2 16 1 1 6];
cases{end + 1} = errfun_case(picks(1), outside, -1, false, prf_errfun(PrfFcn, aps.ap_frm, aps.xy_scaled, -1, outside, Y, 1, false));
out.prf_function = source;
out.cases = cases;
out.predicted_timecourse.P = P{1};
out.predicted_timecourse.values = prf_predict_timecourse(PrfFcn(P{1}, aps.xy_scaled), aps.ap_frm)';
write_json(fullfile(out_dir, 'errfun.json'), out);
end

function c = errfun_case(vertex, P, hrf, css, err)
c.vertex = vertex;
c.P = P;
c.hrf = hrf;
c.css_nonlinearity = css;
c.downsampling = 1;
c.err = json_number(err);
end

%% Output helpers
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
