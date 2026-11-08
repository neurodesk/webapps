function record_css_diagnostics(source, reference, output, smoke)
if nargin < 4, smoke = false; end
% Isolate the remaining full-pipeline CSS fits using recorded MATLAB inputs.
addpath(genpath(source));
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output,'diagnostics.json')) && ...
    ~isfile(fullfile(output,'diagnostics.partial.json')), 'Use a fresh diagnostics directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
environment = reference_environment('source-diagnostics');
write_json('environment.json', environment);
cases = {};
precisions = {'single','double'};
controls = [false true];
vertices = [15 18 22 26 47 58 67 73 74 79 81 88 89];
seedSources = {'recorded','recomputed'};
if smoke
    precisions = {'single'};
    controls = false;
    vertices = 15;
    seedSources = {'recorded'};
end
for precision = precisions
    kind = precision{1};
    metadata = jsondecode(fileread(fullfile(reference, ['pipeline_' kind '_css.json'])));
    assert(strcmp(metadata.precision, kind), 'Wrong pipeline precision');
    pre = jsondecode(fileread(fullfile(reference, [metadata.preprocessing '.json'])));
    assert(strcmp(pre.courses.class, kind), 'Wrong observation class');
    model = samsrf_model_defaults('samsrf_fit_prf', metadata.model);
    assert(~model.Only_Positive_Coarse_Fits && ~model.Aperture_Mean_Response && ...
        model.Smoothed_Coarse_Fit == 0 && model.Coarse_Fit_Percentile == 100 && isempty(model.Seed_Fine_Fit) && ...
        ~isfield(model,'Hooke_Jeeves_Steps') && ~model.Polar_Search_Space && ...
        isempty(model.Hrf) && ~model.Replace_Bad_Fits, 'Unsupported diagnostic model');
    model.Scaled_Param(end+1) = 0;
    model.Only_Positive(end+1) = 1;
    observations = cast(read_array(reference, pre.courses), kind);
    grid = read_array(reference, metadata.grid);
    recordedCorrelations = cast(read_array(reference, metadata.coarseCorrelations), kind);
    hrf = read_array(reference, metadata.hrf);
    aps = load(fullfile(reference, [model.Aperture_File '.mat']));
    xy = aps.ApXY / max(abs(aps.ApXY(:))) * model.Scaling_Factor;
    profile = str2func(model.Prf_Function);
    assert(size(observations,2) <= model.Coarse_Fit_Block_Size, 'Recorder requires one coarse block');
    for nonnegative = controls
        frames = aps.ApFrm;
        if nonnegative
            frames = max(frames, 0);
        end
        predictions = zeros(size(observations,1), size(grid,2));
        for candidate = 1:size(grid,2)
            raw = prf_predict_timecourse(profile(grid(1:3,candidate),xy),frames);
            predictions(:,candidate) = prf_convolve_hrf(raw,hrf,model.Downsample_Predictions);
        end
        correlations = corr(observations, predictions);
        coarseId = sprintf('css_coarse_%s_nonnegative%d',kind,nonnegative);
        coarse = struct('id',coarseId,'kind','css-coarse','precision',kind, ...
            'nonnegativeApertures',nonnegative, ...
            'predictions',array_file([coarseId '_predictions'],predictions), ...
            'correlations',array_file([coarseId '_correlations'],correlations), ...
            'recordedCorrelations',array_file([coarseId '_recorded'],recordedCorrelations));
        cases{end+1} = coarse; %#ok<AGROW>
        % MATLAB columns 47 and 88 are the material double discrepancies in #730.
        for vertex = vertices
            % Both seeds separate reference-host coarse ties from fine-fit changes.
            for seedSource = seedSources
                if nonnegative && strcmp(seedSource{1},'recorded')
                    continue
                end
                seedCorrelations = correlations;
                if strcmp(seedSource{1},'recorded')
                    seedCorrelations = recordedCorrelations;
                end
                scores = seedCorrelations(vertex,:).^2;
                selected = scores >= prctile(scores,model.Coarse_Fit_Percentile);
                seed = [mean(grid(1:3,selected),2); 1]';
                y = observations(:,vertex);
                trace = [];
                errors = [];
                rawTrace = [];
                compressedTrace = [];
                predictionTrace = [];
                reductions = [];
                iterations = {};
                options = optimset('Display','off','OutputFcn',@iteration);
                if isfield(model,'Nelder_Mead_Tolerance')
                    options.TolX = model.Nelder_Mead_Tolerance;
                end
                coarseR2 = max(scores);
                fineFitRun = coarseR2 >= model.Fine_Fit_Threshold;
                parameters = zeros(size(seed));
                objective = 1;
                exitflag = [];
                optimizer = struct('message','Below fine-fit threshold');
                if fineFitRun
                    [parameters, objective, exitflag, optimizer] = fminsearch(@evaluate, seed, options);
                end
                acceptedParameters = parameters;
                accepted = (1-objective) > 0;
                if accepted
                    for parameter = 1:numel(parameters)
                        scaled = model.Scaled_Param(parameter);
                        positive = model.Only_Positive(parameter);
                        if scaled && abs(acceptedParameters(parameter)) > 2*model.Scaling_Factor
                            accepted = false;
                        end
                        if positive && acceptedParameters(parameter) <= 0
                            if positive == 1
                                accepted = false;
                            else
                                acceptedParameters(parameter) = abs(acceptedParameters(parameter));
                                accepted = true;
                            end
                        end
                    end
                end
                raw = [];
                compressed = [];
                x = [];
                beta = [];
                q = [];
                r = [];
                piv = [];
                betaFromQr = [];
                regressionStatus = 'not-fitted';
                if fineFitRun
                    raw = prf_predict_timecourse(profile(acceptedParameters,xy),frames);
                    compressed = raw.^acceptedParameters(end);
                    x = prf_convolve_hrf(compressed,hrf,model.Downsample_Predictions);
                    design = [ones(size(x)) x];
                    regressionStatus = 'nonfinite-design';
                    if all(isfinite(design(:))) && all(isfinite(y(:)))
                        beta = design \ y;
                        [q, r, piv, betaFromQr] = explicit_qr(design,y,kind);
                        regressionStatus = 'recorded';
                    end
                end
                exportParameters = zeros(size(parameters));
                exportR2 = 0;
                exportBeta = zeros(2,1,kind);
                if accepted
                    assert(strcmp(regressionStatus,'recorded'), 'Accepted fit has nonfinite regression inputs');
                    exportParameters = acceptedParameters;
                    exportR2 = 1-objective;
                    exportBeta = beta([2 1]);
                end
                id = sprintf('css_pipeline_%s_v%d_nonnegative%d_%s', ...
                    kind,vertex,nonnegative,seedSource{1});
                item = struct('id',id,'kind','css-trace','precision',kind, ...
                    'vertex',vertex,'vertexIndexBase',1, ...
                    'pipeline',metadata.id,'coarse',coarseId,'seedSource',seedSource{1}, ...
                    'nonnegativeApertures',nonnegative,'exitflag',exitflag, ...
                    'accepted',accepted,'fineFitRun',fineFitRun, ...
                    'coarseR2',array_file([id '_coarse_r2'],coarseR2), ...
                    'sourceSavedFit',struct('betaComputed',accepted, ...
                        'betaOrder',{{'Beta','Baseline'}}, ...
                        'parameters',array_file([id '_saved_parameters'],cast(exportParameters,kind)), ...
                        'r2',array_file([id '_saved_r2'],cast(exportR2,kind)), ...
                        'beta',array_file([id '_saved_beta'],cast(exportBeta,kind))), ...
                    'sourceExport',struct('betaComputed',accepted,'betaOrder',{{'Beta','Baseline'}}, ...
                        'parameters',array_file([id '_export_parameters'],real(cast(exportParameters,kind))), ...
                        'r2',array_file([id '_export_r2'],real(cast(exportR2,kind))), ...
                        'beta',array_file([id '_export_beta'],real(cast(exportBeta,kind)))), ...
                    'acceptedParameters',array_file([id '_accepted_parameters'],acceptedParameters), ...
                    'optimizer',optimizer,'iterations',{iterations}, ...
                    'seed',array_file([id '_seed'],seed), ...
                    'selectedCandidates',array_file([id '_selected'],find(selected)), ...
                    'parameters',array_file([id '_parameters'],parameters), ...
                    'objective',array_file([id '_objective'],objective), ...
                    'observations',array_file([id '_observations'],y), ...
                    'prediction',array_file([id '_prediction'],x), ...
                    'raw',array_file([id '_raw'],raw), ...
                    'compressed',array_file([id '_compressed'],compressed), ...
                    'candidateBeta',array_file([id '_candidate_beta'],beta), ...
                    'betaFromQr',array_file([id '_beta_from_qr'],betaFromQr), ...
                    'regressionStatus',regressionStatus, ...
                    'qrMatchesMldivide',strcmp(regressionStatus,'recorded') && same_bytes(betaFromQr,beta), ...
                    'q',array_file([id '_q'],q), ...
                    'qr',array_file([id '_qr'],r),'pivot',array_file([id '_pivot'],piv), ...
                    'trace',array_file([id '_trace'],trace), ...
                    'errors',array_file([id '_errors'],errors), ...
                    'rawTrace',array_file([id '_raw_trace'],rawTrace), ...
                    'compressedTrace',array_file([id '_compressed_trace'],compressedTrace), ...
                    'predictionTrace',array_file([id '_prediction_trace'],predictionTrace), ...
                    'reductions',array_file([id '_reductions'],reductions), ...
                    'reductionColumns',{{'meanX','meanY','normX','normY','dot','correlation'}});
                cases{end+1} = item; %#ok<AGROW>
                write_json([id '.json'],item);
                write_json('diagnostics.partial.json',struct('environment',environment,'cases',{cases}));
                fprintf('Recorded %s\n',id);
            end
        end
    end
end
% Bracket the prediction scales reached by the double CSS failures. Norms
% must be recorded independently of squared sums at underflow and overflow.
for scale = [1e-162 1e-155 1 1e153 1e154]
    y = [-2; -1; 1; 2];
    for imaginary = [0 0.3]
        x = scale * (y + 1i*imaginary*[1; -1; -1; 1]);
        xc = x - mean(x);
        yc = y - mean(y);
        id = sprintf('css_correlation_double_scale%g_imaginary%g',scale,imaginary);
        r = corr(x,y);
        cases{end+1} = struct('id',id,'kind','css-correlation','precision','double', ...
            'prediction',array_file([id '_prediction'],x), ...
            'observations',array_file([id '_observations'],y), ...
            'norm',array_file([id '_norm'],norm(xc)), ...
            'sumSquares',array_file([id '_sum_squares'],sum(abs(xc).^2)), ...
            'dot',array_file([id '_dot'],xc'*yc), ...
            'correlation',array_file([id '_correlation'],r), ...
            'objective',array_file([id '_objective'],1-r.^2)); %#ok<AGROW>
    end
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
            [q, r, piv, betaFromQr] = explicit_qr(design,y,kind);
            id = sprintf('glm_%s_%g_%g',kind,scale,imaginary);
            cases{end+1} = struct('id',id,'kind','glm','precision',kind, ...
                'prediction',array_file([id '_prediction'],x), ...
                'observations',array_file([id '_observations'],y), ...
                'beta',array_file([id '_beta'],beta), ...
                'q',array_file([id '_q'],q),'qr',array_file([id '_qr'],r), ...
                'pivot',array_file([id '_pivot'],piv), ...
                'betaFromQr',array_file([id '_beta_from_qr'],betaFromQr), ...
                'qrMatchesMldivide',same_bytes(betaFromQr,beta)); %#ok<AGROW>
        end
    end
end
% Bracket the complex regression rank decision independently of CSS fitting.
for precision = {'single','double'}
    kind = precision{1};
    if strcmp(kind,'single')
        exponents = [-4 -3.5 -3 -2.5 -2 2 2.5 3 3.5 4];
    else
        exponents = [-10 -9 -8 -7 -6 6 7 8 9 10];
    end
    for volumes = [16 250]
        t = (1:volumes)';
        y = cast(2*sin(t)+3,kind);
        for exponent = exponents
            for imaginary = [0 0.3]
                x = 10^exponent*(sin(t)+1i*imaginary*cos(t));
                design = [ones(size(x)) x];
                beta = design \ y;
                uniform = cast(design,kind) \ y;
                [q, r, piv, betaFromQr] = explicit_qr(design,y,kind);
                id = sprintf('rank_%s_n%d_e%g_i%g',kind,volumes,exponent,imaginary);
                cases{end+1} = struct('id',id,'kind','glm','precision',kind, ...
                    'prediction',array_file([id '_prediction'],x), ...
                    'observations',array_file([id '_observations'],y), ...
                    'beta',array_file([id '_beta'],beta), ...
                    'q',array_file([id '_q'],q),'qr',array_file([id '_qr'],r), ...
                    'pivot',array_file([id '_pivot'],piv), ...
                    'betaFromQr',array_file([id '_beta_from_qr'],betaFromQr), ...
                    'qrMatchesMldivide',same_bytes(betaFromQr,beta), ...
                    'uniformBeta',array_file([id '_uniform_beta'],uniform)); %#ok<AGROW>
            end
        end
    end
end
write_json('diagnostics.json',struct('environment',environment,'smoke',smoke,'cases',{cases}));

    function error = evaluate(p)
        % Call the actual objective. The parallel recording never supplies its result.
        error = prf_errfun(profile,frames,xy,hrf,p,y,model.Downsample_Predictions,true);
        rawValue = prf_predict_timecourse(profile(p,xy),frames);
        compressedValue = rawValue.^p(end);
        predicted = prf_convolve_hrf(compressedValue,hrf,model.Downsample_Predictions);
        xc = predicted - mean(predicted);
        yc = y - mean(y);
        trace(end+1,:) = double(p(:))';
        errors(end+1,1) = double(error);
        rawTrace(:,end+1) = rawValue;
        compressedTrace(:,end+1) = compressedValue;
        predictionTrace(:,end+1) = predicted;
        reductions(end+1,:) = double([mean(predicted),mean(y),norm(xc),norm(yc),xc'*yc,corr(predicted,y)]);
    end

    function stop = iteration(~, values, state)
        % Match samsrf_prfoptim_loop's nonfinite termination exactly.
        stop = ~isfinite(values.fval);
        iterations{end+1} = struct('state',state,'iteration',values.iteration, ...
            'evaluations',values.funccount,'procedure',values.procedure,'stop',stop);
    end

end

function value = read_array(root, descriptor)
fid = fopen(fullfile(root,descriptor.file),'r','ieee-le');
assert(fid~=-1);
cleanup = onCleanup(@() fclose(fid));
value = reshape(fread(fid,Inf,'double'),descriptor.shape(:)');
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

function write_json(file,value)
fid = fopen(file,'w');
assert(fid~=-1);
cleanup = onCleanup(@() fclose(fid));
fprintf(fid,'%s\n',jsonencode(value,'PrettyPrint',true));
end

function same = same_bytes(a,b)
same = strcmp(class(a),class(b)) && isequal(size(a),size(b)) && ...
    isreal(a) == isreal(b) && ...
    isequal(typecast(real(a(:)),'uint8'),typecast(real(b(:)),'uint8')) && ...
    isequal(typecast(imag(a(:)),'uint8'),typecast(imag(b(:)),'uint8'));
end

function [q,r,piv,betaFromQr] = explicit_qr(design,y,kind)
[q,r,piv] = qr(cast(design,kind),0);
betaFromQr = zeros(size(design,2),1,kind);
betaFromQr(piv) = r \ (q' * y);
end
