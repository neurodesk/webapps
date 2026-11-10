function test_nanmedian()
addpath(fullfile(fileparts(mfilename('fullpath')), 'shims'));
assert(nanmedian([1 NaN 9 3]) == 3);
assert(isequaln(nanmedian([NaN 1 NaN; NaN 3 NaN], 1), [NaN 2 NaN]));
assert(isequal(nanmedian([NaN 1 NaN; NaN 3 NaN], 2), [1; 3]));
assert(isequaln(nanmedian(NaN(3,2)), [NaN NaN]));
assert(isequaln(nanmedian(zeros(0,3), 1), [NaN NaN NaN]));
assert(isequal(nanmedian(single([1 NaN 4 2])), single(2)));
assert(strcmp(class(nanmedian(single([1 NaN 4 2]))), 'single'));
assert(isnan(nanmedian([-Inf Inf])));
assert(nanmedian([Inf NaN Inf]) == Inf);
% On newer Octave, compare directly with the old shim's implementation.
if str2double(strtok(version, '.')) >= 9
    for kind = {'double', 'single'}
        values = cast(reshape(sin(1:420),20,7,3), kind{1});
        values(1:5:end) = NaN;
        for dim = [1 2 3 5]
            assert(isequaln(nanmedian(values,dim), median(values,dim,'omitnan')));
        end
    end
end
fprintf('nanmedian shim preserves values, shapes and precision.\n');
end
