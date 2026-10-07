import React from 'react';
import CustomTooltip from '../common/CustomTooltip';
import { FieldSeverity } from '../../types';

interface FieldSeverityIndicatorProps {
  severity?: FieldSeverity;
  className?: string;
}

export const REQUIRED_SEVERITY_TOOLTIP =
  'Required — data must satisfy this constraint to be compliant';
export const REFERENCE_SEVERITY_TOOLTIP =
  'Reference only — records what the reference protocol used; differing values are still compliant';

/**
 * Coloured dot marking whether a field constraint is a requirement (severity
 * omitted or 'error' — amber) or reference information ('warning' — grey).
 * Shown on every field so the two states read as a stripe down the table,
 * without spending a column on it.
 */
const FieldSeverityIndicator: React.FC<FieldSeverityIndicatorProps> = ({
  severity,
  className = '',
}) => {
  const isReference = severity === 'warning';

  return (
    <CustomTooltip
      content={isReference ? REFERENCE_SEVERITY_TOOLTIP : REQUIRED_SEVERITY_TOOLTIP}
      position="top"
      delay={100}
      className="flex-shrink-0 leading-none"
    >
      <span
        role="img"
        aria-label={isReference ? 'Reference only' : 'Required'}
        className={`block h-1.5 w-1.5 rounded-full cursor-help ${
          isReference
            ? 'bg-content-muted'
            : 'bg-amber-500 dark:bg-amber-400'
        } ${className}`}
      />
    </CustomTooltip>
  );
};

/**
 * A series table shows one column per field, but severity is recorded per
 * series. The column only reads as reference-only when every series that
 * defines the field agrees — a single requiring series makes the column a
 * requirement, since data must satisfy it somewhere.
 */
export function isColumnReferenceOnly(
  severities: (FieldSeverity | undefined)[]
): boolean {
  return severities.length > 0 && severities.every(s => s === 'warning');
}

/**
 * Decodes the dots. Only worth rendering when a schema actually mixes the two
 * states — most schemas are entirely requirements, where the legend is noise.
 */
export const FieldSeverityLegend: React.FC = () => (
  <div className="flex items-center gap-3 text-xs text-content-tertiary">
    <span className="flex items-center gap-1.5">
      <span className="block h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
      <span>Required</span>
    </span>
    <span className="flex items-center gap-1.5">
      <span className="block h-1.5 w-1.5 rounded-full bg-content-muted" />
      <span>Reference only — differing values are still compliant</span>
    </span>
  </div>
);

export default FieldSeverityIndicator;
