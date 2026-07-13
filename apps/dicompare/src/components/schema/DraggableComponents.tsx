import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Acquisition, AcquisitionSelection } from '../../types';

// Draggable wrapper for schema headers (drags entire schema with all acquisitions)
export interface DraggableSchemaProps {
  schemaId: string;
  schemaName: string;
  acquisitionCount: number;
  enabled: boolean;
  children: React.ReactNode;
}

export const DraggableSchema: React.FC<DraggableSchemaProps> = ({
  schemaId,
  schemaName,
  acquisitionCount,
  enabled,
  children
}) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `schema-drag-${schemaId}`,
    data: {
      type: 'schema',
      schemaId,
      schemaName,
      acquisitionCount
    },
    disabled: !enabled
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
  };

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      {children}
    </div>
  );
};

// Draggable wrapper for individual acquisition items
export interface DraggableAcquisitionProps {
  selection: AcquisitionSelection;
  acquisition: Acquisition;
  schemaName: string;
  tags?: string[];
  enabled: boolean;
  children: (isDraggable: boolean) => React.ReactNode;
}

export const DraggableAcquisition: React.FC<DraggableAcquisitionProps> = ({
  selection,
  acquisition,
  schemaName,
  tags,
  enabled,
  children
}) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `acq-drag-${selection.schemaId}-${selection.acquisitionIndex}`,
    data: {
      type: 'acquisition',
      selection,
      acquisition,
      schemaName,
      tags
    },
    disabled: !enabled
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0 : 1,  // Hide completely when dragging - overlay shows the preview
  };

  if (!enabled) {
    return <>{children(false)}</>;
  }

  // Apply listeners to the entire wrapper so dragging works from anywhere on the card
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} className="cursor-grab active:cursor-grabbing">
      {children(true)}
    </div>
  );
};
