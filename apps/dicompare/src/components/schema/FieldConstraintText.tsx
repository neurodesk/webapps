import React from 'react';
import { describeConstraint, GradedConstraint } from '../common/constraintModel';

interface FieldConstraintTextProps {
  /** Graded constraint for scalar numeric fields; absent for other types. */
  graded?: GradedConstraint;
  /** Primary line: the constraint target / formatted value (e.g. "3 ± 0.1"). */
  value: string;
  /** Fallback secondary line for non-graded fields ("Number • tolerance"). */
  typeInfo: string;
}

/**
 * The value-cell text shown in the field/series tables: the constraint target on
 * top and the datatype·constraint label ("Number • reference") always beneath it.
 * When a graded numeric field has a concrete graded band, a grey italic third line
 * spells it out ("warns then fails below 1"), mirroring the number-line editor's
 * inline summary.
 */
const FieldConstraintText: React.FC<FieldConstraintTextProps> = ({ graded, value, typeInfo }) => {
  const described = graded ? describeConstraint(graded) : null;
  // A graded numeric field's target is authoritative; other fields use the value
  // the caller formatted (legacy value / list / enum formatting).
  const target = described ? described.target : value;
  const detail = described ? described.detail : '';
  return (
    <>
      <p className="text-xs text-content-primary break-words">{target}</p>
      <p className="text-xs text-content-tertiary mt-0.5">{typeInfo}</p>
      {detail && <p className="text-xs text-content-tertiary italic mt-0.5 break-words">{detail}</p>}
    </>
  );
};

export default FieldConstraintText;
