import 'react';

declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string | undefined;
  }
}

declare global {
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>;
  }
}
