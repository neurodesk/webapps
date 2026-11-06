function record_css_diagnostics(source, reference, output)
% Isolate the remaining full-pipeline CSS fits using recorded MATLAB inputs.
addpath(genpath(source));
if ~isfolder(output), mkdir(output); end
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
metadata = jsondecode(fileread(fullfile(reference, 'pipeline_single_css.json')));
pre = jsondecode(fileread(fullfile(reference, [metadata.preprocessing '.json'])));
model = metadata.model;
observations = single(read_array(reference, pre.courses));
grid = read_array(reference, metadata.grid);
correlations = single(read_array(reference, metadata.coarseCorrelations));
hrf = read_array(reference, metadata.hrf);
aps = load(fullfile(reference, [model.Aperture_File '.mat']));
frames = aps.ApFrm;
xy = aps.ApXY / max(abs(aps.ApXY(:))) * model.Scaling_Factor;
profile = str2func(model.Prf_Function);
cases = {};
for vertex = [15 26 47 58 74 79 81 88]
    scores = correlations(vertex,:).^2;
    selected = scores >= prctile(scores,100);
    seed = [mean(grid(1:3,selected),2); 1];
    y = observations(:,vertex);
    trace = [];
    errors = [];
    [parameters, objective] = fminsearch(@evaluate, seed, optimset('Display','off'));
    raw = prf_predict_timecourse(profile(parameters,xy),frames);
    compressed = raw.^parameters(end);
    x = prf_convolve_hrf(compressed,hrf,1);
    design = [ones(size(x)) x];
    beta = design \ y;
    [~, r, piv] = qr(single(design),0);
    id = sprintf('css_pipeline_single_v%d',vertex);
    item = struct('id',id,'vertex',vertex,'seed',array_file([id '_seed'],seed), ...
        'parameters',array_file([id '_parameters'],parameters), ...
        'objective',array_file([id '_objective'],objective), ...
        'observations',array_file([id '_observations'],y), ...
        'prediction',array_file([id '_prediction'],x), ...
        'raw',array_file([id '_raw'],raw), ...
        'beta',array_file([id '_beta'],beta), ...
        'qr',array_file([id '_qr'],r),'pivot',array_file([id '_pivot'],piv), ...
        'trace',array_file([id '_trace'],trace), 'errors',array_file([id '_errors'],errors));
    cases{end+1} = item; %#ok<AGROW>
    fprintf('Recorded %s\n',id);
end
% Scale and complexity can select different MATLAB least-squares paths.
t = (1:250)';
for precision = {'single','double'}
    kind = precision{1};
    y = cast(2*sin(t)+3,kind);
    for scale = 10.^(-10:2:10)
        for imaginary = [0 1e-50 0.3]
            x = scale*(sin(t)+1i*imaginary*cos(t));
            design = [ones(size(x)) x];
            beta = design \ y;
            id = sprintf('glm_%s_%g_%g',kind,scale,imaginary);
            cases{end+1} = struct('id',id,'kind','glm','precision',kind, ...
                'prediction',array_file([id '_prediction'],x), ...
                'observations',array_file([id '_observations'],y), ...
                'beta',array_file([id '_beta'],beta)); %#ok<AGROW>
        end
    end
end
fid = fopen('diagnostics.json','w');
assert(fid~=-1);
fprintf(fid,'%s\n',jsonencode(struct('matlabVersion',version,'blas',version('-blas'),'cases',{cases}),'PrettyPrint',true));
fclose(fid);

    function error = evaluate(p)
        error = prf_errfun(profile,frames,xy,hrf,p,y,1,true);
        trace(end+1,:) = double(p(:))';
        errors(end+1,1) = double(error);
    end
end

function value = read_array(root, descriptor)
fid = fopen(fullfile(root,descriptor.file),'r','ieee-le');
assert(fid~=-1);
cleanup = onCleanup(@() fclose(fid));
value = reshape(fread(fid,Inf,'double'),descriptor.shape);
end

function descriptor = array_file(name,value)
descriptor = struct('file',[name '.f64'],'shape',size(value),'class',class(value),'imaginary','');
write_array(descriptor.file,real(value));
if ~isreal(value)
    descriptor.imaginary = [name '.imag.f64'];
    write_array(descriptor.imaginary,imag(value));
end
end

function write_array(path,value)
fid = fopen(path,'w','ieee-le');
assert(fid~=-1);
cleanup = onCleanup(@() fclose(fid));
assert(fwrite(fid,double(value),'double')==numel(value));
end
