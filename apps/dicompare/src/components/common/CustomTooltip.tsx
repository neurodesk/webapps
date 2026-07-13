import React, { useState, useRef, useEffect } from 'react';

interface CustomTooltipProps {
  content: string;
  children: React.ReactNode;
  delay?: number;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

const CustomTooltip: React.FC<CustomTooltipProps> = ({
  content,
  children,
  delay = 200,
  position = 'top',
  className = ''
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const timeoutRef = useRef<NodeJS.Timeout>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();

    // Calculate tooltip position based on the position prop
    let x = 0;
    let y = 0;

    switch (position) {
      case 'top':
        x = rect.left + rect.width / 2;
        y = rect.top - 8;
        break;
      case 'bottom':
        x = rect.left + rect.width / 2;
        y = rect.bottom + 8;
        break;
      case 'left':
        x = rect.left - 8;
        y = rect.top + rect.height / 2;
        break;
      case 'right':
        x = rect.right + 8;
        y = rect.top + rect.height / 2;
        break;
    }

    setCoords({ x, y });

    timeoutRef.current = setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const getTooltipClasses = () => {
    const baseClasses = "fixed z-50 px-2 py-1 text-xs text-white bg-gray-900 rounded shadow-lg pointer-events-none transition-opacity duration-200";
    const positionClasses = {
      top: "transform -translate-x-1/2 -translate-y-full",
      bottom: "transform -translate-x-1/2",
      left: "transform -translate-x-full -translate-y-1/2",
      right: "transform -translate-y-1/2"
    };

    return `${baseClasses} ${positionClasses[position]} ${isVisible ? 'opacity-100' : 'opacity-0'}`;
  };

  const getArrowClasses = () => {
    const baseClasses = "absolute w-2 h-2 bg-gray-900 transform rotate-45";
    const positionClasses = {
      top: "top-full left-1/2 transform -translate-x-1/2 -translate-y-1/2",
      bottom: "bottom-full left-1/2 transform -translate-x-1/2 translate-y-1/2",
      left: "left-full top-1/2 transform -translate-y-1/2 -translate-x-1/2",
      right: "right-full top-1/2 transform -translate-y-1/2 translate-x-1/2"
    };

    return `${baseClasses} ${positionClasses[position]}`;
  };

  return (
    <>
      <div
        ref={containerRef}
        className={`inline-block ${className}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {children}
      </div>

      {/* Tooltip Portal */}
      {typeof document !== 'undefined' && (
        <div
          className={getTooltipClasses()}
          style={{
            left: coords.x,
            top: coords.y,
          }}
        >
          {content}
          <div className={getArrowClasses()} />
        </div>
      )}
    </>
  );
};

export default CustomTooltip;