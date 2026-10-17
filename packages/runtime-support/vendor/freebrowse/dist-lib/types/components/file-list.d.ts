import React from 'react';
export interface FileItem {
    filename: string;
    url: string;
}
interface FileListProps {
    endpoint: string;
    onFileSelect: (file: FileItem) => void;
    emptyMessage?: string;
}
export declare const FileList: React.FC<FileListProps>;
export default FileList;
