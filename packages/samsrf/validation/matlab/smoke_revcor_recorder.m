function smoke_revcor_recorder(source, input, output)
% Execute every recorder branch without a MATLAB license. These outputs are
% deliberately marked smoke and must never become a numerical reference.
assert(exist('OCTAVE_VERSION', 'builtin') ~= 0, 'This smoke test requires Octave');
assert(~isfolder(output), 'Use a fresh smoke directory');
mkdir(output);
shims = fullfile(output, 'shims');
mkdir(shims);
here = fileparts(mfilename('fullpath'));
copyfile(fullfile(here, '..', 'octave', 'shims', '*.m'), shims);
% Retain the actual repaired precision conversion instead of the old double
% identity shim. Emulate MATLAB's automatic .mat extension only in this test.
delete(fullfile(shims, 'samsrf_32bit_srf.m'));
saveShim = fullfile(shims, 'save.m');
text = fileread(saveShim);
site = 'args = varargin;';
assert(numel(strfind(text, site)) == 1);
text = strrep(text, site, sprintf(['args = varargin;\n' ...
    '[~,~,extension] = fileparts(args{1});\n' ...
    'if isempty(extension), args{1} = [args{1} ''.mat'']; end']));
fid = fopen(saveShim, 'w');
assert(fid >= 0);
fprintf(fid, '%s', text);
fclose(fid);
previous = pwd;
oldPath = path;
restore = onCleanup(@() restore_environment(previous, oldPath));
addpath(genpath(source));
addpath(shims);
cd(output);
copyfile(fullfile(source, 'SamSrf_defaults.json'), 'SamSrf_defaults.json');
cases = record_revcor_matrix(input, output, @array_file, @write_json, true);
assert(numel(cases) == 17);
for i = 1:numel(cases)
    item = cases{i};
    if ~strcmp(item.kind, 'pipeline')
        continue
    end
    assert(strcmp(item.savedMaps.class, 'single'));
    assert(strcmp(item.savedCourses.class, 'single'));
    assert(strcmp(item.profiles.class, 'single'));
    vertices = read_array(item.savedVertices);
    assert(isequal(double(vertices(:)), [1; 96]));
    if strcmp(item.analysis, 'cf')
        corrected = read_array(item.recomputedCorrectedCourses);
        assert(isequaln(read_array(item.savedCourses), corrected(:,vertices)));
        assert(isequal(item.profiles.shape, [9 96]));
        profiles = read_array(item.profiles);
        outside = profiles(:,2:95);
        assert(all(isnan(outside(:))));
    else
        assert(strcmp(item.regressors.class, 'double'));
        assert(strcmp(item.savedRegressors.class, 'single'));
        assert(isequal(item.profiles.shape, [400 2]));
    end
end
fprintf('All 17 RC/CF recorder smoke cases passed. Octave does not establish MATLAB parity.\n');
end

function restore_environment(previous, oldPath)
cd(previous);
path(oldPath);
end

function description = array_file(name, value)
assert(isreal(value), 'Unexpected complex RC/CF array');
description = struct('file', [name '.f64'], 'shape', size(value), ...
    'class', class(value), 'imaginary', '');
fid = fopen(description.file, 'w', 'ieee-le');
assert(fid >= 0);
closeFile = onCleanup(@() fclose(fid));
assert(fwrite(fid, double(value), 'double') == numel(value));
end

function value = read_array(description)
fid = fopen(description.file, 'r', 'ieee-le');
assert(fid >= 0);
closeFile = onCleanup(@() fclose(fid));
value = reshape(fread(fid, Inf, 'double'), description.shape);
end

function write_json(name, value)
fid = fopen(name, 'w');
assert(fid >= 0);
closeFile = onCleanup(@() fclose(fid));
fprintf(fid, '%s\n', jsonencode(value));
end
