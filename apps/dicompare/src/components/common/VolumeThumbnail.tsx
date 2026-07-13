import React, { useEffect, useState } from 'react';
import { Brain, Loader2 } from 'lucide-react';
import { getVolumeThumbnail } from '../../utils/niivueThumbnail';

interface VolumeThumbnailProps {
  url: string;
  className?: string;
}

/**
 * Renders a thumbnail preview of a NIfTI/DICOM volume.
 * Shows a loading spinner while generating, falls back to Brain icon on failure.
 */
const VolumeThumbnail: React.FC<VolumeThumbnailProps> = ({ url, className = '' }) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDataUrl(null);

    getVolumeThumbnail(url).then(result => {
      if (!cancelled) {
        setDataUrl(result);
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [url]);

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <Loader2 className="h-4 w-4 animate-spin text-content-tertiary" />
      </div>
    );
  }

  if (dataUrl) {
    return (
      <img
        src={dataUrl}
        alt="Volume preview"
        className={`object-contain ${className}`}
      />
    );
  }

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <Brain className="h-6 w-6 text-content-tertiary" />
    </div>
  );
};

export default VolumeThumbnail;
