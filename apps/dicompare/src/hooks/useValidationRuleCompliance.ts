import { useState, useEffect, useCallback } from 'react';
import { Acquisition, SelectedValidationFunction } from '../types';
import { ComplianceFieldResult } from '../types/schema';
import { dicompareWorkerAPI as dicompareAPI } from '../services/DicompareWorkerAPI';

interface UseValidationRuleComplianceOptions {
  isComplianceMode: boolean;
  isDataProcessing?: boolean;
  realAcquisition?: Acquisition;
  schemaId?: string;
  schemaAcquisitionId?: string;
  schemaAcquisition?: Acquisition;
  getSchemaContent?: (id: string) => Promise<string | null>;
  validationFunctions: SelectedValidationFunction[];
  onComplianceResultsChange?: (results: ComplianceFieldResult[]) => void;
}

interface UseValidationRuleComplianceReturn {
  validationRuleResults: ComplianceFieldResult[];
  allComplianceResults: ComplianceFieldResult[];
  isValidatingRules: boolean;
  validationRuleError: string | null;
  getValidationRuleResult: (func: SelectedValidationFunction) => ComplianceFieldResult;
}

/**
 * Hook to manage validation rule compliance checking.
 * Handles async validation against schemas and data-as-schema sources.
 */
export function useValidationRuleCompliance({
  isComplianceMode,
  isDataProcessing = false,
  realAcquisition,
  schemaId,
  schemaAcquisitionId,
  schemaAcquisition,
  getSchemaContent,
  validationFunctions,
  onComplianceResultsChange,
}: UseValidationRuleComplianceOptions): UseValidationRuleComplianceReturn {
  const [validationRuleResults, setValidationRuleResults] = useState<ComplianceFieldResult[]>([]);
  const [allComplianceResults, setAllComplianceResults] = useState<ComplianceFieldResult[]>([]);
  const [isValidatingRules, setIsValidatingRules] = useState(false);
  const [validationRuleError, setValidationRuleError] = useState<string | null>(null);

  const hasSchemaForValidation = schemaId || schemaAcquisition;

  const performValidationRuleCompliance = useCallback(async () => {
    if (!realAcquisition || (!schemaId && !schemaAcquisition)) return;

    setIsValidatingRules(true);
    setValidationRuleError(null);
    // Clear old results to prevent showing stale data from previous item
    setAllComplianceResults([]);
    setValidationRuleResults([]);

    try {
      let validationResults: ComplianceFieldResult[];

      if (schemaAcquisition) {
        // Data-as-schema mode: validate using the acquisition object directly
        validationResults = await dicompareAPI.validateAcquisitionAgainstAcquisition(
          realAcquisition,
          schemaAcquisition
        );
      } else if (schemaId && getSchemaContent) {
        // Normal mode: validate using schema ID
        validationResults = await dicompareAPI.validateAcquisitionAgainstSchema(
          realAcquisition,
          schemaId,
          getSchemaContent,
          schemaAcquisitionId
        );
      } else {
        throw new Error('No schema available for validation');
      }

      // Store ALL validation results
      setAllComplianceResults(validationResults);

      // Filter to get validation rule results only
      const ruleResults = validationResults.filter(result =>
        result.validationType === 'rule' ||
        validationFunctions.some(func =>
          result.rule_name === (func.customName || func.name) ||
          result.fieldName === (func.customName || func.name)
        )
      );

      setValidationRuleResults(ruleResults);
    } catch (err) {
      console.error('Validation rule compliance error:', err);
      setValidationRuleError(`Rule validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setValidationRuleResults([]);
    } finally {
      setIsValidatingRules(false);
    }
  }, [realAcquisition, schemaId, schemaAcquisition, schemaAcquisitionId, getSchemaContent, validationFunctions]);

  // Run validation when dependencies change
  useEffect(() => {
    if (isComplianceMode && hasSchemaForValidation && realAcquisition && !isDataProcessing) {
      performValidationRuleCompliance();
    }
  }, [isComplianceMode, hasSchemaForValidation, realAcquisition, schemaAcquisitionId, validationFunctions.length, isDataProcessing, performValidationRuleCompliance]);

  // Notify parent when compliance results change
  useEffect(() => {
    if (onComplianceResultsChange) {
      onComplianceResultsChange(allComplianceResults);
    }
  }, [allComplianceResults, onComplianceResultsChange]);

  const getValidationRuleResult = useCallback((func: SelectedValidationFunction): ComplianceFieldResult => {
    const result = validationRuleResults.find(r =>
      r.rule_name === (func.customName || func.name) ||
      r.fieldName === (func.customName || func.name)
    );
    return result || {
      fieldPath: func.id,
      fieldName: func.customName || func.name,
      status: 'unknown',
      message: 'No validation result available',
      actualValue: '',
      expectedValue: '',
      validationType: 'rule',
      seriesName: undefined,
      rule_name: func.customName || func.name
    };
  }, [validationRuleResults]);

  return {
    validationRuleResults,
    allComplianceResults,
    isValidatingRules,
    validationRuleError,
    getValidationRuleResult,
  };
}
