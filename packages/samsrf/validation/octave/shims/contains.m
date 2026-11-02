function tf = contains(str, pattern)
% contains  MATLAB's contains for char and cellstr inputs; Octave 9.2 has none.
%
% samsrf_gii2srf tests contains(funimg, '*') to detect a wildcard file name.
% Returns true when any pattern occurs in str; a logical array for a cellstr.

if ischar(pattern)
    pattern = {pattern};
end
if ischar(str)
    tf = any(cellfun(@(p) ~isempty(strfind(str, p)), pattern));
else
    tf = cellfun(@(s) contains(s, pattern), str);
end
end
