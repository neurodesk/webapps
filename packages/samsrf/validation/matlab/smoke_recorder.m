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
assert(numel(metadata.cases) == 158, 'Expected one coarse case, one trace and every primitive');
item = metadata.cases{2};
assert(item.fineFitRun && item.trace.shape(1) > 5);
assert(item.sourceExport.betaComputed == item.accepted);
assert(isfield(item,'qrMatchesMldivide'));
assert(isfile(item.errors.file) && isfile(item.predictionTrace.file));
regressions = 0;
for i = 1:numel(metadata.cases)
    entry = metadata.cases{i};
    if strcmp(entry.kind,'glm')
        regressions = regressions + 1;
        q = read_array(entry.q);
        r = read_array(entry.qr);
        piv = read_array(entry.pivot);
        y = read_array(entry.observations);
        expected = zeros(2,1,entry.precision);
        expected(piv) = r \ (q' * y);
        assert(isequaln(expected,read_array(entry.betaFromQr)), ...
            ['QR solve belongs to another case: ' entry.id]);
        assert(strcmp(entry.betaFromQr.class,entry.precision));
    end
end
assert(regressions == 146);
candidateBeta = read_array(item.candidateBeta);
assert(isequaln(read_array(item.sourceSavedFit.beta),candidateBeta([2 1])));
fprintf('Recorder smoke passed. Octave outputs do not establish MATLAB parity.\n');
end

function value = read_array(descriptor)
fid = fopen(descriptor.file,'r','ieee-le');
assert(fid ~= -1);
value = reshape(fread(fid,Inf,'double'),descriptor.shape(:)');
fclose(fid);
if ~isempty(descriptor.imaginary)
    fid = fopen(descriptor.imaginary,'r','ieee-le');
    assert(fid ~= -1);
    value = complex(value,reshape(fread(fid,Inf,'double'),descriptor.shape(:)'));
    fclose(fid);
end
value = cast(value,descriptor.class);
end
