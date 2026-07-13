export interface SchemaMetadata {
  id: string;
  filename: string;
  title: string;
  version: string;
  authors: string[];
  uploadDate: string;
  fileSize: number;
  format: 'json' | 'python';
  isValid: boolean;
  description?: string;
  acquisitionCount?: number;
  tags?: string[];
}

export interface ParsedSchema {
  metadata: SchemaMetadata;
  rules: ValidationRule[];
  fields: SchemaField[];
}

export interface ValidationRule {
  fieldPath: string;
  type: 'exact' | 'range' | 'tolerance' | 'contains' | 'required';
  value?: any;
  min?: number;
  max?: number;
  tolerance?: number;
  message?: string;
}

export interface SchemaField {
  path: string;
  tag: string;
  name: string;
  required: boolean;
  dataType: string;
  validation?: ValidationRule[];
}

export interface ComplianceReport {
  schemaId: string;
  timestamp: string;
  overallStatus: 'pass' | 'fail' | 'warning';
  fieldResults: ComplianceFieldResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
  };
}

export interface ComplianceFieldResult {
  fieldPath: string;
  fieldName: string;
  status: 'pass' | 'fail' | 'warning' | 'na' | 'unknown';
  expectedValue?: any;
  actualValue?: any;
  message?: string;
  rule?: ValidationRule;

  // Enhanced validation type support for hybrid schemas
  validationType?: 'field' | 'rule' | 'series';
  seriesName?: string;

  // New fields for hybrid schema rule validation
  rule_name?: string;  // Present for rule validation results
}

export interface SchemaTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  content: string;
  format: 'json' | 'python';
  version?: string;
  authors?: string[];
  tags?: string[];
}