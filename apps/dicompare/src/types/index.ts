import type { GradedConstraint } from '../components/common/constraintModel';

// DICOM Field Types
// Compliance severity when a field constraint is not met. 'error' (default)
// marks it a requirement; 'warning' records it as reference information —
// the value describes what the reference used, but differing is still compliant.
export type FieldSeverity = 'error' | 'warning';

export interface DicomField {
  tag: string | null;  // null for custom/derived fields without DICOM tags
  name: string;
  keyword?: string; // DICOM keyword (e.g., "PatientName")
  value: string | number | string[] | number[] | any;
  vr: string; // Value Representation
  level: 'acquisition' | 'series';
  validationRule?: ValidationRule;
  severity?: FieldSeverity; // omitted = 'error' (a requirement)
  // Scalar numeric fields carry a graded constraint (the number-line editor's
  // model); it is the source of truth for those and supersedes validationRule/
  // severity. Non-numeric fields leave it undefined and use validationRule.
  graded?: GradedConstraint;
  // Free-text rationale for this constraint — why this value, or what the
  // consequence of deviating is. Documentation only; never affects validation.
  notes?: string;
  // Custom compliance messages shown when this field warns / fails, overriding
  // the auto-generated text. '%V' is replaced with the actual value(s) found.
  // Only the applicable one(s) are offered: a required (error) constraint takes
  // an errorMessage, an advisory/graded warn outcome takes a warningMessage.
  warningMessage?: string;
  errorMessage?: string;
  seriesName?: string; // For series-level fields, which series they belong to
  fieldType?: 'standard' | 'derived' | 'private' | 'custom'; // standard=known DICOM tag, derived=calculated/metadata, private=unknown DICOM tag format, custom=user-defined name
  // dataType inferred from value type - no longer stored
}

// Enhanced field types for validation
export type FieldDataType = 'number' | 'string' | 'list_string' | 'list_number' | 'json';
export type ValidationConstraint = 'exact' | 'tolerance' | 'contains' | 'range' | 'contains_any' | 'contains_all';
export type ComplianceStatus = 'OK' | 'ERROR' | 'WARNING' | 'NA';

// Schema Image Types
export interface SchemaImage {
  url: string;
  label?: string;
  description?: string;
}

// Series Types
export interface SeriesField {
  name: string;
  tag: string | null;  // null for custom/derived fields without DICOM tags
  keyword?: string;  // DICOM keyword (e.g. "EchoTime" vs full name "Echo Time")
  value: any;
  validationRule?: ValidationRule;
  severity?: FieldSeverity; // omitted = 'error' (a requirement)
  graded?: GradedConstraint; // scalar numeric series fields (see DicomField.graded)
  // Custom warn/fail compliance messages (see DicomField). '%V' → value(s) found.
  warningMessage?: string;
  errorMessage?: string;
  // Deliberately no `notes` here. Rationale on a series is recorded once
  // against the series (see Series.notes) — the series is the unit a reader
  // reasons about, and per-field notes across a wide table were unreadable.
  fieldType?: 'standard' | 'derived' | 'private' | 'custom';  // standard=known DICOM tag, derived=calculated/metadata, private=unknown DICOM tag format, custom=user-defined name
  // dataType inferred from value type - no longer stored
}

export interface Series {
  name: string;
  fields: SeriesField[];
  images?: SchemaImage[];
  // Rationale for this series as a whole, shown under the series name.
  notes?: string;
}

// Validation Functions Types (imported from validation components)
export type ValidationParameterType = 'number' | 'string' | 'boolean' | 'enum';

// Typed declaration of a rule parameter (library format). The implementation
// reads the configured value via params["name"] / ctx.params["name"].
export interface ValidationParameterDefinition {
  name: string;
  label?: string;
  type: ValidationParameterType;
  description?: string;
  default?: any;
  min?: number;
  max?: number;
  options?: any[];
  unit?: string;
}

export interface ValidationFunction {
  id: string;
  name: string;
  description: string;
  category: string;
  fields: string[];
  // Fields made available to the rule when present but whose absence is not an
  // error (e.g. vendor-specific tags in a rule that branches on Manufacturer)
  optional_fields?: string[];
  // Typed parameter declarations; configured VALUES live in configuredParams
  // (UI) / the schema rule's `parameters` dict (serialized)
  parameterDefinitions?: ValidationParameterDefinition[];
  implementation: string;
  testCases?: any[];
  requiredSystemFields?: string[];
}

export interface SelectedValidationFunction extends ValidationFunction {
  configuredParams?: Record<string, any>;
  customImplementation?: string;
  customName?: string;
  customDescription?: string;
  customFields?: string[];
  customTestCases?: any[];
  enabledSystemFields?: string[];
}

// Acquisition Selection (for multi-select in schema builder)
export interface AcquisitionSelection {
  schemaId: string;
  acquisitionIndex: number;
  schemaName: string;        // For display
  acquisitionName: string;   // For display
}

// Acquisition Types
export interface Acquisition {
  id: string;
  protocolName: string;
  seriesDescription: string;
  detailedDescription?: string; // Extended markdown description (detailed_description in schema)
  totalFiles: number;
  sliceCount?: number; // Number of unique slice locations (actual slices, handles mosaic/enhanced DICOM)
  acquisitionFields: DicomField[];
  // seriesFields removed - field definitions now embedded in series[].fields[]
  series?: Series[];
  validationFunctions?: SelectedValidationFunction[]; // Add validation functions to acquisitions
  tags?: string[]; // Tags/categories for organizing acquisitions
  images?: SchemaImage[]; // Representative images for this acquisition
  seriesFileMapping?: Record<string, string[]>;  // series name -> DICOM filenames
  metadata: {
    manufacturer?: string;
    magneticFieldStrength?: string;
    patientPosition?: string;
    sequenceName?: string;
    seriesCount?: number;
    echoTimes?: string[];
    multibandFactor?: string;
    notes?: string;
    [key: string]: any;
  };
}

// Schema/Template Types
export interface ValidationRule {
  type: ValidationConstraint;
  value?: any;
  min?: number;
  max?: number;
  pattern?: string;
  tolerance?: number;
  errorTolerance?: number; // graded tolerance for list_number fields (warn band)
  contains?: string;
  substring?: string; // Alias for contains
  contains_any?: any[]; // Array of values for contains_any constraint (substrings for strings, elements for lists)
  contains_all?: any[]; // Array of values for contains_all constraint (lists only - all must be present)
}

export interface SchemaField {
  tag: string;
  name: string;
  required: boolean;
  validationRule: ValidationRule;
  level: 'acquisition' | 'series';
  dataType?: FieldDataType;
}

export interface Template {
  id: string;
  name: string;
  description?: string;
  authors: string[];
  version: string;
  createdDate: string;
  format: 'json' | 'python';
  acquisitions: {
    [acquisitionId: string]: {
      name: string;
      fields: SchemaField[];
    };
  };
}

// Compliance Types
export interface ComplianceResult {
  fieldTag: string;
  fieldName: string;
  status: 'pass' | 'fail' | 'warning' | 'na';
  expected: any;
  actual: any;
  message: string;
}

export interface SeriesComplianceResult {
  seriesId: string;
  seriesDescription: string;
  overallStatus: 'pass' | 'fail' | 'warning' | 'na';
  fieldResults: ComplianceResult[];
}

export interface AcquisitionComplianceResult {
  acquisitionId: string;
  acquisitionName: string;
  overallStatus: 'pass' | 'fail' | 'warning' | 'na';
  acquisitionFieldResults: ComplianceResult[];
  seriesResults: SeriesComplianceResult[];
}

export interface ComplianceReport {
  id: string;
  templateName: string;
  templateVersion: string;
  analysisDate: string;
  overallStatus: 'pass' | 'fail' | 'warning' | 'na';
  summary: {
    totalAcquisitions: number;
    passedAcquisitions: number;
    failedAcquisitions: number;
    totalSeries: number;
    passedSeries: number;
    failedSeries: number;
  };
  acquisitionResults: AcquisitionComplianceResult[];
}

// Data Loading Types
export interface DicomFile {
  id: string;
  filename: string;
  size: number;
  path: string;
  metadata: { [key: string]: any };
}

export interface ProcessingProgress {
  currentFile: number;
  totalFiles: number;
  currentOperation: string;
  percentage: number;
}

// UI State Types
export interface AppState {
  currentAcquisitions: Acquisition[];
  selectedTemplate: Template | null;
  complianceReport: ComplianceReport | null;
  isProcessing: boolean;
  processingProgress: ProcessingProgress | null;
}