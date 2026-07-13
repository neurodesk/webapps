/**
 * Print report generator utility.
 * Generates HTML for printing acquisition compliance reports.
 */

import { marked, Renderer } from 'marked';
import { WorkspaceItem, SchemaMetadata } from '../contexts/WorkspaceContext';
import { Acquisition, DicomField, SchemaImage } from '../types';
import { ComplianceFieldResult } from '../types/schema';
import { getItemFlags } from './workspaceHelpers';
import { escapeHtml, normalizeTag } from './stringHelpers';
import { isAnalysisTag } from './tagUtils';
import { isFlatImageUrl, isVolumeUrl } from './imageHelpers';
import { getVolumeThumbnail, getVolumeThumbnailFromFile } from './niivueThumbnail';
import { Dcm2niix } from '@niivue/dcm2niix';
import { formatFieldDisplay, buildValidationRuleFromField } from './fieldFormatters';

/**
 * Create a custom marked renderer that demotes headers by a specified number of levels.
 * This ensures markdown content headers are subordinate to the section title.
 */
function createDemotedHeaderRenderer(demoteBy: number = 2): Renderer {
  const renderer = new Renderer();
  renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
    const newDepth = Math.min(depth + demoteBy, 6); // Cap at H6
    const originalClass = `readme-h${depth}`; // Track original level for styling
    return `<h${newDepth} class="${originalClass}">${text}</h${newDepth}>\n`;
  };
  return renderer;
}

/** Options controlling which sections appear in the print report and image display. */
export interface PrintSectionOptions {
  header?: boolean;
  readme?: boolean;
  schemaImages?: boolean;
  referenceDicoms?: boolean;
  testDicoms?: boolean;
  testNotes?: boolean;
  validationRules?: boolean;
  fieldsTable?: boolean;
  seriesTable?: boolean;
  uncheckedFields?: boolean;
  uncheckedSeriesFields?: boolean;
  /** For schema viewer: per-acquisition overrides keyed by acquisition index */
  perAcquisition?: Record<number, {
    description?: boolean;
    images?: boolean;
    validationRules?: boolean;
    fieldsTable?: boolean;
    seriesTable?: boolean;
  }>;
  /** Image display options */
  imageScale?: number; // multiplier for image size (default 1)
  imageColumns?: number; // number of columns (0 = auto/stack)
  /** Specific schema image indices to include (undefined = all) */
  selectedSchemaImages?: number[];
}

const defaultSections: PrintSectionOptions = {
  header: true,
  readme: true,
  schemaImages: true,
  referenceDicoms: true,
  testDicoms: true,
  testNotes: true,
  validationRules: true,
  fieldsTable: true,
  seriesTable: true,
  uncheckedFields: true,
  uncheckedSeriesFields: true,
};

export interface PrintReportOptions {
  selectedItem: WorkspaceItem;
  loadedSchemaAcquisition: Acquisition | null;
  complianceResults: ComplianceFieldResult[];
  schemaMetadata: SchemaMetadata | null;
  /** Reference DICOM files for thumbnail generation */
  dicomFiles?: File[];
  /** Test DICOM files for thumbnail generation */
  testDicomFiles?: File[];
  /** Section visibility and image options */
  sections?: PrintSectionOptions;
}

/**
 * Generate HTML for the print report.
 */
export async function generatePrintReportHtml(options: PrintReportOptions): Promise<string> {
  const { selectedItem, loadedSchemaAcquisition, complianceResults, schemaMetadata, dicomFiles, testDicomFiles } = options;
  const sec = { ...defaultSections, ...options.sections };

  // Compute flags
  const flags = getItemFlags(selectedItem);
  const { isEmptyItem, hasCreatedSchema, hasAttachedData, hasAttachedSchema, isUsedAsSchema } = flags;

  // Determine schema acquisition (what we're validating against)
  const schemaAcquisition = hasAttachedSchema && loadedSchemaAcquisition
    ? loadedSchemaAcquisition
    : (isEmptyItem && !hasCreatedSchema && !hasAttachedSchema && hasAttachedData && selectedItem.attachedData)
      ? selectedItem.attachedData
      : selectedItem.acquisition;

  // Determine if we're in compliance mode
  const isComplianceMode =
    (selectedItem.source === 'data' && selectedItem.dataUsageMode === 'validation-subject' && hasAttachedSchema) ||
    (isUsedAsSchema && hasAttachedData) ||
    (!isUsedAsSchema && hasAttachedSchema);

  // Get the real data (if compliance mode)
  const realAcquisition = isComplianceMode
    ? (selectedItem.source === 'data' && selectedItem.dataUsageMode === 'validation-subject'
        ? selectedItem.acquisition
        : isUsedAsSchema
          ? selectedItem.attachedData
          : selectedItem.acquisition)
    : null;

  // Build header info
  const schemaName = schemaAcquisition.protocolName || 'Acquisition';
  const schemaDescription = schemaAcquisition.seriesDescription || '';
  const dataName = realAcquisition?.protocolName || '';
  const dataDescription = realAcquisition?.seriesDescription || '';

  // Get schema source info
  let schemaSource = '';
  let schemaTags: string[] = [];
  let schemaAuthors: string[] = [];
  let schemaVersion = '';

  if (hasAttachedSchema && selectedItem.attachedSchema?.schema) {
    const schema = selectedItem.attachedSchema.schema;
    const acquisitionTags = schemaAcquisition.tags || (schemaAcquisition as any).acquisitionTags;
    schemaSource = schema.name || '';
    schemaTags = acquisitionTags || schema.tags || [];
    schemaAuthors = schema.authors || [];
    schemaVersion = schema.version || '';
  } else if (hasCreatedSchema && schemaMetadata) {
    schemaSource = schemaMetadata.name || '';
    schemaTags = schemaMetadata.tags || [];
    schemaAuthors = schemaMetadata.authors || [];
    schemaVersion = schemaMetadata.version || '';
  } else if (selectedItem.schemaOrigin) {
    schemaSource = selectedItem.schemaOrigin.schemaName || '';
  }

  const fields = schemaAcquisition.acquisitionFields || [];
  const series = schemaAcquisition.series || [];
  const validationFunctions = schemaAcquisition.validationFunctions || [];

  // Determine if this is data-only
  const isDataOnly = !isUsedAsSchema && !hasAttachedSchema && !hasCreatedSchema;

  // Build HTML sections (respecting section options)
  const fieldsHtml = sec.fieldsTable ? buildFieldsHtml(fields, isComplianceMode, isDataOnly, complianceResults) : '';
  const seriesHtml = sec.seriesTable ? buildSeriesHtml(series, isComplianceMode, complianceResults) : '';
  const uncheckedFieldsHtml = sec.uncheckedFields ? buildUncheckedFieldsHtml(isComplianceMode, realAcquisition, fields, series) : '';
  const uncheckedSeriesFieldsHtml = sec.uncheckedSeriesFields ? buildUncheckedSeriesFieldsHtml(isComplianceMode, realAcquisition, fields, series) : '';
  const rulesHtml = sec.validationRules ? buildRulesHtml(validationFunctions, isComplianceMode, complianceResults) : '';

  // Images: only generate thumbnails for sections that are enabled
  const needsVolumeThumbnails = sec.schemaImages && schemaAcquisition.images?.some(img => isVolumeUrl(img.url));
  const volumeThumbnails = needsVolumeThumbnails ? await preGenerateVolumeThumbnails([schemaAcquisition]) : new Map<string, string>();
  const filteredImages = sec.schemaImages
    ? (sec.selectedSchemaImages
        ? schemaAcquisition.images?.filter((_, i) => sec.selectedSchemaImages!.includes(i))
        : schemaAcquisition.images)
    : undefined;
  const schemaImagesHtml = sec.schemaImages ? buildImagesHtml(filteredImages, volumeThumbnails) : '';
  const refDicomImagesHtml = sec.referenceDicoms ? await buildDicomThumbnailsHtml(dicomFiles, 'Reference DICOMs') : '';
  const testDicomImagesHtml = sec.testDicoms ? await buildDicomThumbnailsHtml(testDicomFiles, 'Test DICOMs') : '';

  // Build reference information section (readme + schema images + reference DICOMs)
  const readmeContent = schemaAcquisition.detailedDescription || schemaMetadata?.description || '';
  const showReadme = sec.readme || sec.schemaImages || sec.referenceDicoms;
  const readmeHtml = showReadme ? buildReadmeHtml(
    sec.readme ? readmeContent : '', schemaSource, schemaVersion, schemaAuthors,
    refDicomImagesHtml, schemaImagesHtml
  ) : '';

  // Build test data information section (test notes + test DICOMs)
  const showTestNotes = sec.testNotes || sec.testDicoms;
  const testNotesHtml = showTestNotes ? buildTestNotesHtml(
    isComplianceMode, sec.testNotes ? selectedItem.testDataNotes : undefined,
    testDicomImagesHtml
  ) : '';
  const headerHtml = sec.header ? buildHeaderHtml(
    isDataOnly,
    schemaSource,
    schemaVersion,
    schemaName,
    schemaDescription,
    schemaTags,
    isComplianceMode,
    realAcquisition,
    dataName,
    dataDescription
  ) : '';

  // Assemble full HTML
  return buildFullHtml(
    schemaName,
    headerHtml,
    testNotesHtml,
    rulesHtml,
    fieldsHtml,
    seriesHtml,
    uncheckedFieldsHtml,
    uncheckedSeriesFieldsHtml,
    readmeHtml,
    '',
    sec
  );
}

export interface SchemaViewerPrintOptions {
  schemaName: string;
  schemaVersion?: string;
  schemaAuthors?: string[];
  schemaDescription?: string;
  acquisitions: Acquisition[];
  /** Section visibility and image options */
  sections?: PrintSectionOptions;
}

/**
 * Generate HTML for printing from the Schema Viewer page.
 * Prints all provided acquisitions with their fields, series, and validation rules.
 */
export async function generateSchemaViewerPrintHtml(options: SchemaViewerPrintOptions): Promise<string> {
  const { schemaName, schemaVersion, schemaAuthors, schemaDescription, acquisitions } = options;
  const sec = { ...defaultSections, ...options.sections };

  // Pre-generate thumbnails for all volume images (only if images are enabled)
  const anyImagesEnabled = sec.schemaImages || acquisitions.some((_, i) => sec.perAcquisition?.[i]?.images !== false);
  const volumeThumbnails = anyImagesEnabled ? await preGenerateVolumeThumbnails(acquisitions) : new Map<string, string>();

  // Parse schema-level description as markdown
  let descriptionHtml = '';
  if (schemaDescription && sec.readme) {
    const demotedRenderer = createDemotedHeaderRenderer(2);
    descriptionHtml = marked.parse(schemaDescription, { renderer: demotedRenderer }) as string;
  }

  // Build acquisition sections
  const acquisitionSections = acquisitions.map((acq, idx) => {
    const acqSec = sec.perAcquisition?.[idx];
    const fields = acq.acquisitionFields || [];
    const series = acq.series || [];
    const validationFunctions = acq.validationFunctions || [];

    const showFields = acqSec?.fieldsTable ?? sec.fieldsTable;
    const showSeries = acqSec?.seriesTable ?? sec.seriesTable;
    const showRules = acqSec?.validationRules ?? sec.validationRules;
    const showDesc = acqSec?.description ?? sec.readme;
    const showImages = acqSec?.images ?? sec.schemaImages;

    const fieldsHtml = showFields ? buildFieldsHtml(fields, false, false, []) : '';
    const seriesHtml = showSeries ? buildSeriesHtml(series, false, []) : '';
    const rulesHtml = showRules ? buildRulesHtml(validationFunctions, false, []) : '';

    // Acquisition-level description + images combined into one section
    const imagesHtml = showImages ? buildImagesHtml(acq.images, volumeThumbnails) : '';
    const acqInfoHtml = ((showDesc && acq.detailedDescription) || imagesHtml)
      ? buildReadmeHtml(
          showDesc ? (acq.detailedDescription || '') : '',
          '', '', [],
          '', imagesHtml
        )
      : '';

    const tagsHtml = acq.tags && acq.tags.length > 0
      ? `<div class="schema-tags">${acq.tags.map(t => `<span class="tag${isAnalysisTag(t) ? ' tag-analysis' : ''}">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    const hasContent = fieldsHtml || seriesHtml || rulesHtml || acqInfoHtml;
    const emptyMsg = hasContent ? '' : '<p style="color: #666; font-style: italic;">No fields, series, or validation rules defined.</p>';

    return `
      <div class="acquisition-section">
        <div class="acquisition-header">
          <h2 class="acquisition-title">${escapeHtml(acq.protocolName || `Acquisition ${idx + 1}`)}</h2>
          ${acq.seriesDescription ? `<div class="acquisition-subtitle">${escapeHtml(acq.seriesDescription)}</div>` : ''}
          ${tagsHtml}
        </div>
        ${acqInfoHtml}
        ${rulesHtml}
        ${fieldsHtml}
        ${seriesHtml}
        ${emptyMsg}
      </div>
    `;
  }).join('');

  const headerHtml = sec.header ? buildHeaderHtml(
    false,
    '',
    schemaVersion || '',
    schemaName,
    schemaAuthors && schemaAuthors.length > 0 ? schemaAuthors.join(', ') : '',
    [],
    false,
    null,
    '',
    ''
  ) : '';

  const schemaReadmeHtml = descriptionHtml
    ? buildReadmeHtml(schemaDescription || '', '', '', [])
    : '';

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${escapeHtml(schemaName)} - Schema Report</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <style>${getPrintStyles(sec)}</style>
      </head>
      <body>
        ${headerHtml}
        ${schemaReadmeHtml}
        ${acquisitionSections}
        <div class="print-date">Printed on ${new Date().toLocaleDateString()}</div>
      </body>
    </html>
  `;
}

/**
 * Check if we're running in Electron
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

/**
 * Export to PDF (Electron only).
 * Returns a promise that resolves to true if successful, false otherwise.
 */
export async function exportToPdf(html: string, defaultFilename: string): Promise<{ success: boolean; message?: string }> {
  if (!window.electronAPI) {
    return { success: false, message: 'PDF export is only available in the desktop app' };
  }

  try {
    const result = await window.electronAPI.generatePdf(html, defaultFilename);

    if (result.canceled) {
      return { success: false, message: 'Export cancelled' };
    }

    if (result.success) {
      return { success: true, message: `PDF saved to ${result.filePath}` };
    }

    return { success: false, message: result.error || 'Failed to generate PDF' };
  } catch (error) {
    console.error('PDF export failed:', error);
    return { success: false, message: String(error) };
  }
}

/**
 * Open a print window with the given HTML content (browser only).
 */
export function openPrintWindow(html: string): boolean {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    return false;
  }
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  return true;
}

// Helper functions

function findFieldCompliance(
  complianceResults: ComplianceFieldResult[],
  tag: string,
  fieldName?: string,
  keyword?: string
): ComplianceFieldResult | undefined {
  return complianceResults.find(r => {
    if (r.validationType === 'rule') return false;
    if (tag && r.fieldPath === tag) return true;
    if (keyword && r.fieldName === keyword) return true;
    if (fieldName && r.fieldName === fieldName) return true;
    if (tag && r.fieldPath?.includes(tag)) return true;
    const normalizedTag = normalizeTag(tag);
    if (normalizedTag && r.fieldPath && normalizeTag(r.fieldPath) === normalizedTag) return true;
    return false;
  });
}

function buildFieldsHtml(
  fields: DicomField[],
  isComplianceMode: boolean,
  isDataOnly: boolean,
  complianceResults: ComplianceFieldResult[]
): string {
  if (fields.length === 0) return '';

  const rows = fields.map(f => {
    const fieldName = f.name || f.keyword || (f as any).field || '';
    const keyword = f.keyword || '';
    const tag = f.tag || '';
    const validationRule = buildValidationRuleFromField(f);
    const expectedValue = escapeHtml(formatFieldDisplay(f.value, validationRule, { showValue: true, showConstraint: true }));

    const fieldCompliance = isComplianceMode ? findFieldCompliance(complianceResults, tag, fieldName, keyword) : null;
    const actualValue = fieldCompliance?.actualValue;
    const actualDisplay = actualValue !== null && actualValue !== undefined
      ? escapeHtml(formatFieldDisplay(actualValue, undefined, { showValue: true, showConstraint: false }))
      : '<span class="na">—</span>';

    let status = '';
    let statusClass = '';
    if (fieldCompliance) {
      status = fieldCompliance.message || (fieldCompliance.status === 'pass' ? 'Passed' : 'Failed');
      statusClass = fieldCompliance.status === 'pass' ? 'pass' :
                   fieldCompliance.status === 'fail' ? 'fail' :
                   fieldCompliance.status === 'warning' ? 'warning' : 'unknown';
    } else if (isComplianceMode) {
      status = 'Checking...';
      statusClass = 'unknown';
    }

    return `
      <tr>
        <td><span class="field-name">${escapeHtml(fieldName)}</span>${tag ? ` <code>${escapeHtml(tag)}</code>` : ''}</td>
        <td>${expectedValue}</td>
        ${isComplianceMode ? `<td>${actualDisplay}</td><td class="${statusClass}">${status}</td>` : ''}
      </tr>
    `;
  }).join('');

  return `
    <h2>Fields</h2>
    <table>
      <thead>
        <tr>
          <th style="width: 30%">Field</th>
          <th style="width: ${isComplianceMode ? '25%' : '50%'}">${isDataOnly ? 'Value' : 'Expected Value'}</th>
          ${isComplianceMode ? '<th style="width: 25%">Actual Value</th><th style="width: 20%">Status</th>' : ''}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildSeriesHtml(
  series: any[],
  isComplianceMode: boolean,
  complianceResults: ComplianceFieldResult[]
): string {
  if (series.length === 0) return '';

  const allSeriesFields: Array<{ tag: string; name: string; keyword?: string }> = [];
  const seenFieldKeys = new Set<string>();

  series.forEach(s => {
    const seriesFields = Array.isArray(s.fields) ? s.fields : Object.values(s.fields || {});
    seriesFields.forEach((f: any) => {
      const fieldKey = f.tag || f.name;
      if (!seenFieldKeys.has(fieldKey)) {
        seenFieldKeys.add(fieldKey);
        allSeriesFields.push({ tag: f.tag || '', name: f.name || f.keyword || f.field || '', keyword: f.keyword });
      }
    });
  });

  if (allSeriesFields.length === 0) return '';

  const headerCells = allSeriesFields.map(f =>
    `<th><span class="field-name">${escapeHtml(f.keyword || f.name)}</span>${f.tag ? ` <code>${escapeHtml(f.tag)}</code>` : ''}</th>`
  ).join('');

  const rows = series.map((s, i) => {
    const seriesFields = Array.isArray(s.fields) ? s.fields : Object.values(s.fields || {});
    const cells = allSeriesFields.map(headerField => {
      const field = seriesFields.find((f: any) => (f.tag || f.name) === (headerField.tag || headerField.name));
      const value = field?.value !== undefined ? escapeHtml(field.value) : '—';
      return `<td>${value}</td>`;
    }).join('');

    let statusCell = '';
    if (isComplianceMode) {
      const seriesResult = complianceResults.find(r =>
        r.validationType === 'series' && r.seriesName === s.name
      );
      const status = seriesResult?.message || (seriesResult?.status === 'pass' ? 'Passed' : seriesResult?.status === 'fail' ? 'Failed' : 'No result');
      const statusClass = seriesResult?.status === 'pass' ? 'pass' :
                          seriesResult?.status === 'fail' ? 'fail' :
                          seriesResult?.status === 'warning' ? 'warning' : 'unknown';
      statusCell = `<td class="${statusClass}">${escapeHtml(status)}</td>`;
    }

    return `<tr><td><span class="field-name">${escapeHtml(s.name || `Series ${i + 1}`)}</span></td>${cells}${statusCell}</tr>`;
  }).join('');

  return `
    <h2>Series</h2>
    <table>
      <thead><tr><th>Series</th>${headerCells}${isComplianceMode ? '<th>Status</th>' : ''}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildUncheckedFieldsHtml(
  isComplianceMode: boolean,
  realAcquisition: Acquisition | null | undefined,
  fields: DicomField[],
  series: any[]
): string {
  if (!isComplianceMode || !realAcquisition) return '';

  const realFields = realAcquisition.acquisitionFields || [];
  const schemaFieldIds = new Set<string>();
  const schemaKeywords = new Set<string>();
  const schemaNames = new Set<string>();

  fields.forEach(f => {
    const normalizedTag = normalizeTag(f.tag);
    if (normalizedTag) schemaFieldIds.add(normalizedTag);
    if (f.keyword) schemaKeywords.add(f.keyword.toLowerCase());
    if (f.name) schemaNames.add(f.name.toLowerCase());
  });

  series.forEach(s => {
    const seriesFields = Array.isArray(s.fields) ? s.fields : Object.values(s.fields || {});
    seriesFields.forEach((f: any) => {
      const normalizedTag = normalizeTag(f.tag);
      if (normalizedTag) schemaFieldIds.add(normalizedTag);
      if (f.keyword) schemaKeywords.add(f.keyword.toLowerCase());
      if (f.name) schemaNames.add(f.name.toLowerCase());
    });
  });

  if (schemaFieldIds.size === 0 && schemaKeywords.size === 0 && schemaNames.size === 0) {
    return '';
  }

  const uncheckedFields = realFields.filter(f => {
    const normalizedTag = normalizeTag(f.tag);
    const hasTag = normalizedTag && schemaFieldIds.has(normalizedTag);
    const hasKeyword = f.keyword && schemaKeywords.has(f.keyword.toLowerCase());
    const hasName = f.name && schemaNames.has(f.name.toLowerCase());
    return !hasTag && !hasKeyword && !hasName;
  });

  if (uncheckedFields.length === 0) return '';

  const rows = uncheckedFields.map(f => {
    const fieldName = f.name || f.keyword || '';
    const tag = f.tag || '';
    return `
      <tr>
        <td><span class="field-name">${escapeHtml(fieldName)}</span>${tag ? ` <code>${escapeHtml(tag)}</code>` : ''}</td>
        <td>${escapeHtml(f.value)}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="unchecked-section">
      <h2 class="unchecked-header">${uncheckedFields.length} field${uncheckedFields.length === 1 ? '' : 's'} in data not validated by schema</h2>
      <table class="unchecked-table">
        <thead><tr><th style="width: 40%">Field</th><th style="width: 60%">Value in Data</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function buildUncheckedSeriesFieldsHtml(
  isComplianceMode: boolean,
  realAcquisition: Acquisition | null | undefined,
  fields: DicomField[],
  series: any[]
): string {
  if (!isComplianceMode || !realAcquisition || !realAcquisition.series) return '';

  // Build schema field identifiers
  const schemaFieldIds = new Set<string>();
  const schemaKeywords = new Set<string>();
  const schemaNames = new Set<string>();

  fields.forEach(f => {
    const normalizedTag = normalizeTag(f.tag);
    if (normalizedTag) schemaFieldIds.add(normalizedTag);
    if (f.keyword) schemaKeywords.add(f.keyword.toLowerCase());
    if (f.name) schemaNames.add(f.name.toLowerCase());
  });

  series.forEach(s => {
    const seriesFields = Array.isArray(s.fields) ? s.fields : Object.values(s.fields || {});
    seriesFields.forEach((f: any) => {
      const normalizedTag = normalizeTag(f.tag);
      if (normalizedTag) schemaFieldIds.add(normalizedTag);
      if (f.keyword) schemaKeywords.add(f.keyword.toLowerCase());
      if (f.name) schemaNames.add(f.name.toLowerCase());
    });
  });

  if (schemaFieldIds.size === 0 && schemaKeywords.size === 0 && schemaNames.size === 0) {
    return '';
  }

  // Helper to check if a field is in the schema
  const isFieldInSchema = (f: any) => {
    const normalizedTag = normalizeTag(f.tag);
    const hasTag = normalizedTag && schemaFieldIds.has(normalizedTag);
    const hasKeyword = f.keyword && schemaKeywords.has(f.keyword.toLowerCase());
    const hasName = f.name && schemaNames.has(f.name.toLowerCase());
    return hasTag || hasKeyword || hasName;
  };

  // Collect unique unchecked field names
  const uncheckedFieldNames = new Set<string>();

  // Filter series to only include unchecked fields
  const filteredSeries = realAcquisition.series.map((s, idx) => {
    const seriesFields = Array.isArray(s.fields) ? s.fields : Object.values(s.fields || {});
    const uncheckedFields = seriesFields.filter((f: any) => {
      if (!isFieldInSchema(f)) {
        const key = f.keyword || f.name || f.tag;
        uncheckedFieldNames.add(key);
        return true;
      }
      return false;
    });
    return {
      name: s.name || `Series ${String(idx + 1).padStart(2, '0')}`,
      fields: uncheckedFields
    };
  }).filter(s => s.fields.length > 0);

  if (filteredSeries.length === 0) return '';

  const fieldNamesList = Array.from(uncheckedFieldNames);
  const maxRows = 20;
  const displaySeries = filteredSeries.slice(0, maxRows);
  const hasMore = filteredSeries.length > maxRows;

  // Build header cells for each unchecked field
  const headerCells = fieldNamesList.map(name => `<th>${escapeHtml(name)}</th>`).join('');

  // Build rows
  const rows = displaySeries.map(s => {
    const cells = fieldNamesList.map(fieldName => {
      const field: any = s.fields.find((f: any) => (f.keyword || f.name || f.tag) === fieldName);
      if (!field) return '<td>—</td>';
      const value = Array.isArray(field.value)
        ? field.value.slice(0, 3).join(', ') + (field.value.length > 3 ? '...' : '')
        : String(field.value ?? '');
      return `<td>${escapeHtml(value)}</td>`;
    }).join('');
    return `<tr><td class="series-name">${escapeHtml(s.name)}</td>${cells}</tr>`;
  }).join('');

  const moreMessage = hasMore
    ? `<p class="more-series-note">... and ${filteredSeries.length - maxRows} more series</p>`
    : '';

  return `
    <div class="unchecked-section">
      <h2 class="unchecked-header">${filteredSeries.length} series not validated by schema</h2>
      <table class="unchecked-table">
        <thead><tr><th>Series</th>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${moreMessage}
    </div>
  `;
}

function buildReadmeHtml(
  content: string,
  schemaSource: string,
  schemaVersion: string,
  schemaAuthors: string[],
  refImagesHtml: string = '',
  schemaImagesHtml: string = ''
): string {
  const hasContent = content || refImagesHtml || schemaImagesHtml;
  if (!hasContent) return '';

  const metaHtml = schemaSource ? `
    <div class="readme-meta">
      <div class="readme-meta-item"><strong>Schema:</strong> ${escapeHtml(schemaSource)}${schemaVersion ? ` v${escapeHtml(schemaVersion)}` : ''}</div>
      ${schemaAuthors.length > 0 ? `<div class="readme-meta-item"><strong>Authors:</strong> ${schemaAuthors.map(a => escapeHtml(a)).join(', ')}</div>` : ''}
    </div>
  ` : '';

  let parsedContent = '';
  if (content) {
    const demotedRenderer = createDemotedHeaderRenderer(2);
    parsedContent = marked.parse(content, { renderer: demotedRenderer }) as string;
  }

  return `
    <div class="readme-section">
      <h2>Reference Information</h2>
      ${metaHtml}
      ${parsedContent ? `<div class="readme-content">${parsedContent}</div>` : ''}
      ${refImagesHtml}
      ${schemaImagesHtml}
    </div>
  `;
}

function buildTestNotesHtml(isComplianceMode: boolean, testDataNotes?: string, testDicomImagesHtml: string = ''): string {
  const hasContent = testDataNotes || testDicomImagesHtml;
  if (!hasContent) return '';

  let parsedContent = '';
  if (testDataNotes) {
    const demotedRenderer = createDemotedHeaderRenderer(2);
    parsedContent = marked.parse(testDataNotes, { renderer: demotedRenderer }) as string;
  }

  return `
    <div class="test-notes-section">
      <h2>Test Data Information</h2>
      ${parsedContent ? `<div class="test-notes-content">${parsedContent}</div>` : ''}
      ${testDicomImagesHtml}
    </div>
  `;
}

function buildRulesHtml(
  validationFunctions: any[],
  isComplianceMode: boolean,
  complianceResults: ComplianceFieldResult[]
): string {
  if (validationFunctions.length === 0) return '';

  const rows = validationFunctions.map(v => {
    const ruleName = v.customName || v.name || 'Unnamed Rule';
    const ruleDescription = v.customDescription || v.description || '';
    const ruleFields = v.customFields || v.fields || [];

    const ruleCompliance = isComplianceMode ? complianceResults.find(r =>
      r.rule_name === ruleName || r.fieldName === ruleName
    ) : null;

    let ruleStatus = '';
    let ruleStatusClass = '';
    if (ruleCompliance) {
      ruleStatus = ruleCompliance.message || (ruleCompliance.status === 'pass' ? 'OK' : 'Failed');
      ruleStatusClass = ruleCompliance.status === 'pass' ? 'pass' :
                       ruleCompliance.status === 'fail' ? 'fail' :
                       ruleCompliance.status === 'warning' ? 'warning' : 'unknown';
    } else if (isComplianceMode) {
      ruleStatus = 'No result';
      ruleStatusClass = 'unknown';
    }

    const fieldsHtml = ruleFields.length > 0
      ? `<div class="rule-fields">${ruleFields.map((f: string) => `<span class="field-tag-badge">${escapeHtml(f)}</span>`).join('')}</div>`
      : '';

    return `
      <tr>
        <td>
          <div class="field-name">${escapeHtml(ruleName)}</div>
          ${fieldsHtml}
        </td>
        <td>${escapeHtml(ruleDescription)}</td>
        ${isComplianceMode ? `<td class="${ruleStatusClass}">${escapeHtml(ruleStatus)}</td>` : ''}
      </tr>
    `;
  }).join('');

  return `
    <h2>Validation Rules</h2>
    <table>
      <thead>
        <tr>
          <th style="width: 25%">Rule</th>
          <th style="width: ${isComplianceMode ? '45%' : '75%'}">Description</th>
          ${isComplianceMode ? '<th style="width: 30%">Status</th>' : ''}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildHeaderHtml(
  isDataOnly: boolean,
  schemaSource: string,
  schemaVersion: string,
  schemaName: string,
  schemaDescription: string,
  schemaTags: string[],
  isComplianceMode: boolean,
  realAcquisition: Acquisition | null | undefined,
  dataName: string,
  dataDescription: string
): string {
  const primaryLabel = isDataOnly ? 'Data' : 'Reference';
  const primaryItemClass = isDataOnly ? 'data' : 'schema';

  const tagsHtml = schemaTags.length > 0 && !isDataOnly
    ? `<div class="schema-tags">${schemaTags.map(t => `<span class="tag${isAnalysisTag(t) ? ' tag-analysis' : ''}">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  const sourceHtml = schemaSource && !isDataOnly
    ? `<div class="schema-source">From <strong>${escapeHtml(schemaSource)}</strong>${schemaVersion ? ` v${escapeHtml(schemaVersion)}` : ''}</div>`
    : '';

  const dataItemHtml = isComplianceMode && realAcquisition
    ? `
      <div class="header-item data">
        <div class="header-label">Test Data</div>
        <div class="header-title">${escapeHtml(dataName) || 'DICOM Data'}</div>
        ${dataDescription ? `<div class="header-subtitle">${escapeHtml(dataDescription)}</div>` : ''}
      </div>
    `
    : '';

  return `
    <div class="header-section">
      <div class="header-row">
        <div class="header-item ${primaryItemClass}">
          <div class="header-label">${primaryLabel}</div>
          ${sourceHtml}
          <div class="header-title">${escapeHtml(schemaName)}</div>
          ${schemaDescription ? `<div class="header-subtitle">${escapeHtml(schemaDescription)}</div>` : ''}
          ${tagsHtml}
        </div>
        ${dataItemHtml}
      </div>
    </div>
  `;
}

/**
 * Pre-generate thumbnails for all volume images in a list of acquisitions.
 * Returns a map of URL -> data URL for use in buildImagesHtml.
 */
async function preGenerateVolumeThumbnails(acquisitions: Acquisition[]): Promise<Map<string, string>> {
  const thumbnails = new Map<string, string>();
  const volumeUrls = new Set<string>();

  for (const acq of acquisitions) {
    for (const img of acq.images || []) {
      if (isVolumeUrl(img.url)) {
        volumeUrls.add(img.url);
      }
    }
  }

  await Promise.all(
    [...volumeUrls].map(async (url) => {
      const dataUrl = await getVolumeThumbnail(url);
      if (dataUrl) thumbnails.set(url, dataUrl);
    })
  );

  return thumbnails;
}

/**
 * Convert DICOM files to NIfTI and generate thumbnails for each volume.
 * Returns HTML for a strip of DICOM volume thumbnails.
 */
async function buildDicomThumbnailsHtml(files: File[] | undefined, label: string): Promise<string> {
  if (!files || files.length === 0) return '';

  try {
    const dcm2niix = new Dcm2niix();
    await dcm2niix.init();
    const resultFiles: File[] = await dcm2niix.input(files).run();
    const niftiFiles = resultFiles.filter(
      (f: File) => f.name.endsWith('.nii') || f.name.endsWith('.nii.gz')
    );

    if (niftiFiles.length === 0) return '';

    const sorted = [...niftiFiles].sort((a, b) => a.name.localeCompare(b.name));
    const items: string[] = [];

    for (const nifti of sorted) {
      const thumbnail = await getVolumeThumbnailFromFile(nifti);
      const name = escapeHtml(nifti.name);
      if (thumbnail) {
        items.push(`
          <div class="image-strip-item">
            <img src="${thumbnail}" alt="${name}" class="image-strip-img" />
            <div class="image-strip-label">${name}</div>
          </div>
        `);
      } else {
        items.push(`
          <div class="image-strip-item image-strip-volume">
            <div class="image-strip-volume-icon">&#x1F9E0;</div>
            <div class="image-strip-label">${name}</div>
          </div>
        `);
      }
    }

    return `
      <div class="image-strip-section">
        <h3>Images</h3>
        <div class="image-strip">${items.join('')}</div>
      </div>
    `;
  } catch (err) {
    console.warn('Failed to generate DICOM thumbnails for print:', err);
    return '';
  }
}

function buildImagesHtml(images?: SchemaImage[], volumeThumbnails?: Map<string, string>): string {
  if (!images || images.length === 0) return '';

  const items = images.map(img => {
    const label = escapeHtml(img.label || img.url.split('/').pop() || 'Image');
    if (isFlatImageUrl(img.url)) {
      return `
        <div class="image-strip-item">
          <img src="${escapeHtml(img.url)}" alt="${label}" class="image-strip-img" />
          <div class="image-strip-label">${label}</div>
        </div>
      `;
    } else if (isVolumeUrl(img.url)) {
      const thumbnail = volumeThumbnails?.get(img.url);
      if (thumbnail) {
        return `
          <div class="image-strip-item">
            <img src="${thumbnail}" alt="${label}" class="image-strip-img" />
            <div class="image-strip-label">${label}</div>
          </div>
        `;
      }
      return `
        <div class="image-strip-item image-strip-volume">
          <div class="image-strip-volume-icon">&#x1F9E0;</div>
          <div class="image-strip-label">${label}</div>
        </div>
      `;
    }
    return '';
  }).filter(Boolean).join('');

  if (!items) return '';

  return `
    <div class="image-strip-section">
      <h3>Images</h3>
      <div class="image-strip">${items}</div>
    </div>
  `;
}

function buildFullHtml(
  schemaName: string,
  headerHtml: string,
  testNotesHtml: string,
  rulesHtml: string,
  fieldsHtml: string,
  seriesHtml: string,
  uncheckedFieldsHtml: string,
  uncheckedSeriesFieldsHtml: string,
  readmeHtml: string,
  imagesHtml: string = '',
  sections?: PrintSectionOptions
): string {
  const hasContent = fieldsHtml || seriesHtml || rulesHtml || readmeHtml || testNotesHtml || imagesHtml;
  const emptyMessage = hasContent ? '' : '<p style="color: #666;">No fields, series, or validation rules defined.</p>';

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${escapeHtml(schemaName)} - Acquisition Details</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <style>${getPrintStyles(sections)}</style>
      </head>
      <body>
        ${headerHtml}
        ${readmeHtml}
        ${imagesHtml}
        ${testNotesHtml}
        ${rulesHtml}
        ${fieldsHtml}
        ${seriesHtml}
        ${uncheckedFieldsHtml}
        ${uncheckedSeriesFieldsHtml}
        ${emptyMessage}
        <div class="print-date">Printed on ${new Date().toLocaleDateString()}</div>
      </body>
    </html>
  `;
}

function getPrintStyles(sections?: PrintSectionOptions): string {
  const scale = sections?.imageScale ?? 1;
  const cols = sections?.imageColumns ?? 0;
  return `
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 40px;
      max-width: 1000px;
      margin: 0 auto;
      color: #1a1a1a;
    }
    .header-section { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 2px solid #e5e5e5; }
    .schema-source { font-size: 12px; color: #666; margin-bottom: 4px; }
    .schema-source strong { color: #333; }
    .schema-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .tag { display: inline-block; padding: 3px 10px; background: #e0e7ff; color: #3730a3; font-size: 11px; border-radius: 12px; font-weight: 500; }
    .tag-analysis { background: #f3e8ff; color: #7e22ce; }
    .header-row { display: flex; gap: 40px; }
    .header-item { flex: 1; }
    .header-item.schema { border-left: 3px solid #2563eb; padding-left: 12px; }
    .header-item.data { border-left: 3px solid #d97706; padding-left: 12px; }
    .header-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #666; margin-bottom: 4px; }
    .header-title { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
    .header-subtitle { font-size: 14px; color: #666; }
    h2 { font-size: 16px; margin-top: 28px; margin-bottom: 12px; border-bottom: 1px solid #ddd; padding-bottom: 8px; color: #333; }
    h3 { font-size: 14px; margin-top: 20px; margin-bottom: 8px; color: #444; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 12px; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; font-weight: 600; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 10px; color: #666; }
    .field-name { font-weight: 500; color: #1a1a1a; }
    .rule-fields { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .field-tag-badge { display: inline-block; padding: 2px 6px; background: #dbeafe; color: #1d4ed8; font-size: 10px; border-radius: 3px; }

    .pass { color: #16a34a; font-weight: 500; }
    .fail { color: #dc2626; font-weight: 500; }
    .warning { color: #ca8a04; font-weight: 500; }
    .unknown { color: #9ca3af; font-style: italic; }
    .na { color: #9ca3af; }
    .note { font-size: 11px; color: #666; font-style: italic; margin-top: 8px; }
    .unchecked-section { margin-top: 24px; }
    .unchecked-header { color: #333; margin-top: 0; }
    .unchecked-table th { background: #f9fafb; }
    .unchecked-table td { color: #1a1a1a; }
    .more-series-note { font-size: 12px; color: #666; font-style: italic; margin-top: 8px; text-align: center; }
    .readme-section { margin-top: 32px; border-top: 2px solid #3b82f6; background: #eff6ff; border-radius: 8px; padding: 20px; }
    .readme-section > h2 { color: #1e40af; margin-top: 0; margin-bottom: 16px; border-bottom: none; padding-bottom: 0; }
    .readme-section > h3, .readme-section .image-strip-section > h3 { font-size: 14px; font-weight: 600; color: #1e40af; margin-top: 20px; margin-bottom: 8px; border-bottom: none; padding-bottom: 0; }
    .readme-meta { background: #dbeafe; border: 1px solid #93c5fd; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; }
    .readme-meta-item { font-size: 12px; color: #1e40af; margin: 4px 0; }
    .readme-meta-item strong { color: #1e3a8a; }
    .readme-content { font-size: 13px; line-height: 1.6; color: #1e3a8a; }
    .readme-content .readme-h1 { font-size: 16px; font-weight: 600; margin-top: 24px; margin-bottom: 12px; border-bottom: none; padding-bottom: 0; color: #1e40af; }
    .readme-content .readme-h2 { font-size: 14px; font-weight: 600; margin-top: 20px; margin-bottom: 8px; border-bottom: none; padding-bottom: 0; color: #1e40af; }
    .readme-content .readme-h3 { font-size: 13px; font-weight: 600; margin-top: 16px; margin-bottom: 6px; color: #1e40af; }
    .readme-content .readme-h4 { font-size: 12px; font-weight: 600; margin-top: 14px; margin-bottom: 6px; color: #1e40af; }
    .readme-content p { margin: 12px 0; }
    .readme-content ul, .readme-content ol { margin: 12px 0; padding-left: 24px; }
    .readme-content li { margin: 4px 0; }
    .readme-content a { color: #2563eb; text-decoration: underline; }
    .readme-content code { background: #dbeafe; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 11px; color: #1e40af; }
    .test-notes-section { margin-top: 32px; border-top: 2px solid #fbbf24; background: #fffbeb; border-radius: 8px; padding: 20px; }
    .test-notes-section > h2 { color: #92400e; margin-top: 0; margin-bottom: 16px; border-bottom: none; padding-bottom: 0; }
    .test-notes-section > h3, .test-notes-section .image-strip-section > h3 { font-size: 14px; font-weight: 600; color: #92400e; margin-top: 20px; margin-bottom: 8px; border-bottom: none; padding-bottom: 0; }
    .test-notes-content { font-size: 13px; line-height: 1.6; color: #451a03; }
    .test-notes-content .readme-h1 { font-size: 16px; font-weight: 600; margin-top: 24px; margin-bottom: 12px; color: #92400e; }
    .test-notes-content .readme-h2 { font-size: 14px; font-weight: 600; margin-top: 20px; margin-bottom: 8px; color: #92400e; }
    .test-notes-content .readme-h3 { font-size: 13px; font-weight: 600; margin-top: 16px; margin-bottom: 6px; color: #92400e; }
    .test-notes-content p { margin: 12px 0; }
    .test-notes-content ul, .test-notes-content ol { margin: 12px 0; padding-left: 24px; }
    .test-notes-content li { margin: 4px 0; }
    .test-notes-content code { background: #fef3c7; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 11px; }
    .image-strip-section { margin-top: 12px; margin-bottom: 0; }
    .image-strip { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; }
    .image-strip-item { border: 1px solid #e5e5e5; border-radius: 6px; overflow: hidden; background: #fafafa; ${cols > 0 ? `width: calc(${(100 / cols).toFixed(1)}% - ${Math.round((cols - 1) * 12 / cols)}px);` : ''} }
    .image-strip-img { display: block; background: #1a1a2e; ${cols > 0 ? 'width: 100%;' : `max-width: 100%; ${scale !== 1 ? `width: ${Math.round(576 * scale)}px;` : ''}`} }
    .image-strip-volume { height: 80px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .image-strip-volume-icon { font-size: 24px; line-height: 1; }
    .image-strip-label { padding: 4px 8px; font-size: 10px; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-top: 1px solid #e5e5e5; }
    .print-date { color: #999; font-size: 11px; margin-top: 40px; text-align: center; }
    .schema-header { margin-bottom: 24px; padding-bottom: 20px; border-bottom: 2px solid #e5e5e5; }
    .schema-title { font-size: 24px; font-weight: 700; margin: 0 0 6px 0; }
    .schema-meta { font-size: 13px; color: #666; margin-bottom: 12px; }
    .schema-desc { font-size: 13px; line-height: 1.6; color: #333; margin-bottom: 0; }
    .schema-desc p { margin: 8px 0; }
    .schema-desc ul, .schema-desc ol { margin: 8px 0; padding-left: 24px; }
    .schema-desc li { margin: 3px 0; }
    .schema-desc a { color: #2563eb; text-decoration: underline; }
    .schema-desc code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
    .acquisition-section { margin-top: 32px; border-top: 1px solid #e5e5e5; padding-top: 20px; }
    .acquisition-section:first-of-type { margin-top: 24px; }
    .acquisition-header { margin-bottom: 12px; }
    .acquisition-title { font-size: 18px; font-weight: 600; margin: 0 0 4px 0; border-bottom: none; padding-bottom: 0; color: #1a1a1a; }
    .acquisition-subtitle { font-size: 13px; color: #666; margin-bottom: 6px; }
    .acq-description { font-size: 12px; line-height: 1.5; color: #444; margin-bottom: 12px; padding: 10px 14px; background: #f9fafb; border-radius: 6px; border-left: 3px solid #2563eb; }
    .acq-description p { margin: 6px 0; }
    @media print {
      body { padding: 20px; }
      h2 { page-break-after: avoid; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; }
      thead { display: table-header-group; }
      .unchecked-section { page-break-before: auto; }
      .unchecked-header { page-break-after: avoid; }
      .acquisition-section { page-break-inside: avoid; break-inside: avoid; }
    }
  `;
}
