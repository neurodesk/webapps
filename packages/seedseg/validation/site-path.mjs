import path from 'node:path';

export function resolveSiteFile(root, requestPath, paths = path) {
  const file = paths.resolve(root, `.${requestPath.endsWith('/') ? `${requestPath}index.html` : requestPath}`);
  const child = paths.relative(root, file);
  if (child === '..' || child.startsWith(`..${paths.sep}`) || paths.isAbsolute(child)) {
    throw new Error('Outside site');
  }
  return file;
}
