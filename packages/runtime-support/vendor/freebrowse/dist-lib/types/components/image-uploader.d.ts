interface ImageUploaderProps {
    onUpload: (files: File[]) => Promise<void>;
    compact?: boolean;
}
export default function ImageUploader({ onUpload, compact }: ImageUploaderProps): import("react/jsx-runtime").JSX.Element;
export {};
