function record_css_pipelines(source, input, output, spmSource)
% Record the double CSS pipeline through samsrf_fit_prf with the original
% (signed) apertures and with a nonnegative control, max(ApFrm, 0), on the
% same X001 subset as reference.json's pipeline_double_css.
assert(isfile(fullfile(output, 'source.json')), 'Run prepare.py first');
assert(~isfile(fullfile(output, 'pipelines.json')), 'Use a fresh output directory');
addpath(genpath(source));
addpath(spmSource);
previous = pwd;
cleanup = onCleanup(@() cd(previous));
cd(output);
set(groot, 'defaultFigureVisible', 'off');
defaults = jsondecode(fileread(fullfile(source, 'SamSrf_defaults.json')));
defaults.def_64bit = true;
meta = reference_environment('source-css-pipelines');
meta.source = jsondecode(fileread('source.json'));
manifest = jsondecode(fileread(fullfile(input, 'manifest.json')));
if isstruct(manifest.datasets)
    manifest.datasets = num2cell(manifest.datasets);
end
meta.input = manifest;
write_json('environment.json', meta);
write_json('SamSrf_defaults.json', defaults);
converted = samsrf_32bit_srf(struct('Data', [pi 1/3]));
assert(strcmp(class(converted.Data), 'double'), 'Precision setting was not honored');
dataset = [];
for k = 1:numel(manifest.datasets)
    if strcmp(manifest.datasets{k}.id, 'x001_lh')
        dataset = manifest.datasets{k};
    end
end
assert(~isempty(dataset), 'Missing the X001 left-hemisphere dataset');
folder = fullfile(input, dataset.id);
files = cellfun(@(p) fullfile(folder, p), dataset.runs, 'UniformOutput', false);
Srf = samsrf_gii2srf(files, '', 1, true, true, '');
Srf.Hemisphere = dataset.hemisphere;
% Prepared as record_matrix does: the raw movie, vectorised by SamSrf.
data = load(fullfile(input, dataset.apertures));
aperture = fullfile(output, 'aps_x001_lh_1');
save([aperture '.mat'], '-struct', 'data', '-v7');
VectoriseApertures(aperture);
movefile([aperture '_vec.mat'], [aperture '.mat']);
data = load([aperture '.mat']);
data.ApFrm = max(data.ApFrm, 0);
save([aperture '_nonnegative.mat'], '-struct', 'data', '-v7');
cases = {};
for nonnegative = [false true]
    aperture = fullfile(output, 'aps_x001_lh_1');
    id = 'pipeline_double_css';
    if nonnegative
        aperture = [aperture '_nonnegative']; %#ok<AGROW>
        id = [id '_nonnegative']; %#ok<AGROW>
    end
    radius = dataset.radius;
    Model = struct('Name', id, ...
        'Prf_Function', '@(P,XY)prf_gaussian_rf(P(1),P(2),P(3),XY)', ...
        'Param_Names', {{'x0', 'y0', 'Sigma'}}, 'Scaled_Param', [1 1 1], ...
        'Only_Positive', [0 0 1], 'Scaling_Factor', radius, ...
        'TR', dataset.tr, 'Downsample_Predictions', dataset.downsample, ...
        'Hrf', [], 'Aperture_File', aperture, ...
        'Param1', [-0.6 0 0.6] * radius, 'Param2', [-0.6 0 0.6] * radius, ...
        'Param3', [0.125 0.333] * radius, 'Replace_Bad_Fits', false, ...
        'Fine_Fit_Threshold', 0.01, 'Noise_Ceiling_Threshold', 0, ...
        'Coarse_Fit_Only', false, 'Compressive_Nonlinearity', true);
    cases{end+1} = fit_case(id, Srf, Model, defaults, output, nonnegative); %#ok<AGROW>
    write_json('pipelines.json.partial', struct('cases', {cases}));
end
write_json('pipelines.json', struct('environment', meta, 'cases', {cases}));
fprintf('Recorded %d double CSS pipelines\n', numel(cases));
end

function item = fit_case(id, Srf, Model, defaults, output, nonnegative)
work = fullfile(output, 'work', id);
assert(~isfolder(work), 'Use fresh analysis directories');
mkdir(work);
write_json(fullfile(work, 'SamSrf_defaults.json'), defaults);
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(work);
modelJson = Model;
Model.Prf_Function = str2func(Model.Prf_Function);
filename = samsrf_fit_prf(Model, Srf);
result = load([filename '.mat']);
savedMaps = result.Srf.Data;
% Keep the saved complex values; samsrf_expand_srf exports real parts.
result.Srf = samsrf_expand_srf(result.Srf);
search = load(fullfile(work, ['src_' id '.mat']));
cd(previous);
clear restore
modelJson.Aperture_File = erase(modelJson.Aperture_File, [output filesep]);
item = struct('id', id, 'kind', 'pipeline', 'analysis', 'prf', 'precision', 'double', ...
    'nonnegativeApertures', nonnegative, 'model', modelJson, ...
    'values', {result.Srf.Values}, 'maps', array_file([id '_maps'], result.Srf.Data), ...
    'savedMaps', array_file([id '_saved_maps'], savedMaps), ...
    'courses', array_file([id '_courses'], Srf.Data), ...
    'hrf', array_file([id '_hrf'], result.Model.Hrf), ...
    'grid', array_file([id '_grid'], search.S));
if isfield(Srf, 'Noise_Ceiling')
    item.noiseCeiling = array_file([id '_ceiling'], Srf.Noise_Ceiling);
end
write_json([id '.json'], item);
fprintf('Recorded %s\n', id);
end

function descriptor = array_file(name, value)
descriptor = struct('file', [name '.f64'], 'shape', size(value), 'class', class(value), 'imaginary', '');
write_array(descriptor.file, real(value));
if ~isreal(value)
    descriptor.imaginary = [name '.imag.f64'];
    write_array(descriptor.imaginary, imag(value));
end
end

function write_array(path, value)
fid = fopen(path, 'w', 'ieee-le');
assert(fid ~= -1);
cleanup = onCleanup(@() fclose(fid));
assert(fwrite(fid, double(value), 'double') == numel(value));
end

function write_json(path, value)
fid = fopen(path, 'w');
assert(fid ~= -1);
cleanup = onCleanup(@() fclose(fid));
fprintf(fid, '%s\n', jsonencode(value, 'PrettyPrint', true));
end
