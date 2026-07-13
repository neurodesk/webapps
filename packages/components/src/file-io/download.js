export function arrayBufferToFile(buffer, name, type = 'application/octet-stream') {
  return new File([new Blob([buffer], { type })], name, { type });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadFile(file) {
  downloadBlob(file, file.name);
}

export function downloadArrayBuffer(buffer, filename, type = 'application/octet-stream') {
  downloadBlob(new Blob([buffer], { type }), filename);
}
