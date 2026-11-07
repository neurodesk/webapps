function smoke_recorder(source, reference, output)
% Exercise recording plumbing only. Octave results are never parity references.
assert(exist('OCTAVE_VERSION','builtin') ~= 0, 'This smoke test requires Octave');
assert(~isfolder(output), 'Use a fresh smoke directory');
mkdir(output);
fid = fopen(fullfile(output,'reference_environment.m'),'w');
assert(fid ~= -1);
fprintf(fid, ['function value = reference_environment(mode)\n' ...
    'value = struct(''executionMode'',mode,''smokeInterpreter'',''Octave'');\nend\n']);
fclose(fid);
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
clear reference_environment
record_css_diagnostics(source,reference,output,true);
metadata = jsondecode(fileread('diagnostics.json'));
assert(metadata.smoke && strcmp(metadata.environment.smokeInterpreter,'Octave'));
assert(numel(metadata.cases) == 2, 'Expected one coarse case and one optimizer trace');
item = metadata.cases{2};
assert(item.fineFitRun && item.trace.shape(1) > 5);
assert(item.sourceExport.betaComputed == item.accepted);
assert(isfield(item,'qrMatchesMldivide'));
assert(isfile(item.errors.file) && isfile(item.predictionTrace.file));
fprintf('Recorder smoke passed. Octave outputs do not establish MATLAB parity.\n');
end
