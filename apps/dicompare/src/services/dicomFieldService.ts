// Service for managing DICOM field data and external field list fetching
// This maintains the clean separation between mock data and UI components

import { FieldDataType } from '../types';
import { getDataTypeFromVR, getSuggestedConstraintForVR, getSuggestedToleranceValue } from '../utils/vrMapping';
import { roundDicomValue } from '../utils/valueRounding';

export interface DicomFieldDefinition {
  tag: string;
  name: string;
  keyword?: string;
  valueRepresentation?: string;
  valueMultiplicity?: string;
  retired?: string;
  id?: string;
  // Legacy compatibility
  vr: string;
  description?: string;
}

// Cache for field list to avoid repeated fetches
let cachedFieldList: DicomFieldDefinition[] | null = null;
let fetchPromise: Promise<DicomFieldDefinition[]> | null = null;

// Fetch DICOM field list from external source
export const fetchDicomFieldList = async (): Promise<DicomFieldDefinition[]> => {
  // Return cached data if available
  if (cachedFieldList) {
    return cachedFieldList;
  }

  // Return existing promise if fetch is in progress
  if (fetchPromise) {
    return fetchPromise;
  }

  // Create new fetch promise
  fetchPromise = new Promise(async (resolve, reject) => {
    try {
      const response = await fetch('https://raw.githubusercontent.com/innolitics/dicom-standard/refs/heads/master/standard/attributes.json');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      // Transform the official DICOM standard data
      const fieldList: DicomFieldDefinition[] = data
        .filter((field: any) => field.retired !== 'Y') // Exclude retired fields
        .map((field: any) => ({
          tag: field.tag,
          name: field.name,
          keyword: field.keyword,
          valueRepresentation: field.valueRepresentation,
          valueMultiplicity: field.valueMultiplicity,
          retired: field.retired,
          id: field.id,
          // Legacy compatibility
          vr: field.valueRepresentation,
          description: `${field.name} (${field.valueRepresentation}, ${field.valueMultiplicity})`
        }));

      // Cache the result
      cachedFieldList = fieldList;
      resolve(fieldList);
    } catch (error) {
      console.warn('Failed to fetch DICOM field list from official standard, using fallback data:', error);

      // Fallback to mock data if external fetch fails
      const fallbackData = getFallbackFieldList();
      cachedFieldList = fallbackData;
      resolve(fallbackData);
    } finally {
      fetchPromise = null;
    }
  });

  return fetchPromise;
};

// Fallback field list for offline use or when external source is unavailable
const getFallbackFieldList = (): DicomFieldDefinition[] => [
  { tag: '(0008,0008)', name: 'Image Type', keyword: 'ImageType', valueRepresentation: 'CS', valueMultiplicity: '2-n', retired: 'N', id: '00080008', vr: 'CS', description: 'Image identification characteristics' },
  { tag: '(0008,0060)', name: 'Modality', keyword: 'Modality', valueRepresentation: 'CS', valueMultiplicity: '1', retired: 'N', id: '00080060', vr: 'CS', description: 'Type of equipment that originally acquired the data' },
  { tag: '(0008,0070)', name: 'Manufacturer', keyword: 'Manufacturer', valueRepresentation: 'LO', valueMultiplicity: '1', retired: 'N', id: '00080070', vr: 'LO', description: 'Manufacturer of the equipment that produced the composite instances' },
  { tag: '(0018,0081)', name: 'Echo Time', keyword: 'EchoTime', valueRepresentation: 'DS', valueMultiplicity: '1', retired: 'N', id: '00180081', vr: 'DS', description: 'Time in msec between the middle of the excitation pulse and the peak of the echo' },
  { tag: '0008,0080', name: 'InstitutionName', vr: 'LO', description: 'Institution or organization to which the identified individual is responsible' },
  { tag: '0008,1010', name: 'StationName', vr: 'SH', description: 'User defined name identifying the machine' },
  { tag: '0008,1030', name: 'StudyDescription', vr: 'LO', description: 'Institution-generated description or classification of the Study' },
  { tag: '0008,103E', name: 'SeriesDescription', vr: 'LO', description: 'User provided description of the Series' },
  { tag: '0008,1090', name: 'ManufacturerModelName', vr: 'LO', description: 'Manufacturer model name of the equipment' },

  { tag: '0018,0015', name: 'BodyPartExamined', vr: 'CS', description: 'Text description of the part of the body examined' },
  { tag: '0018,0020', name: 'ScanningSequence', vr: 'CS', description: 'Description of the type of data taken' },
  { tag: '0018,0021', name: 'SequenceVariant', vr: 'CS', description: 'Variant of the Scanning Sequence' },
  { tag: '0018,0022', name: 'ScanOptions', vr: 'CS', description: 'Parameters of scanning sequence' },
  { tag: '0018,0023', name: 'MRAcquisitionType', vr: 'CS', description: 'Identification of data encoding scheme' },
  { tag: '0018,0024', name: 'SequenceName', vr: 'SH', description: 'User or equipment generated sequence identifier' },

  { tag: '0018,0050', name: 'SliceThickness', vr: 'DS', description: 'Nominal slice thickness, in mm' },
  { tag: '0018,0080', name: 'RepetitionTime', vr: 'DS', description: 'The period of time in msec between the beginning of a pulse sequence' },
  { tag: '0018,0081', name: 'EchoTime', vr: 'DS', description: 'Time in msec between the middle of the excitation pulse and the peak of the echo' },
  { tag: '0018,0082', name: 'InversionTime', vr: 'DS', description: 'Time in msec after the middle of inverting RF pulse to middle of excitation pulse' },
  { tag: '0018,0087', name: 'MagneticFieldStrength', vr: 'DS', description: 'Nominal field strength of MR magnet, in Tesla' },
  { tag: '0018,0088', name: 'SpacingBetweenSlices', vr: 'DS', description: 'Spacing between slices, in mm' },
  { tag: '0018,0089', name: 'NumberOfPhaseEncodingSteps', vr: 'IS', description: 'Total number of lines in k-space in the phase encoding direction' },
  { tag: '0018,0095', name: 'PixelBandwidth', vr: 'DS', description: 'Reciprocal of the total sampling period, in hertz per pixel' },

  { tag: '0018,1000', name: 'DeviceSerialNumber', vr: 'LO', description: 'Manufacturer serial number of the equipment' },
  { tag: '0018,1020', name: 'SoftwareVersions', vr: 'LO', description: 'Manufacturer software version of the equipment' },
  { tag: '0018,1250', name: 'ReceiveCoilName', vr: 'SH', description: 'Name of the receive coil used' },
  { tag: '0018,1314', name: 'FlipAngle', vr: 'DS', description: 'Steady state angle in degrees to which the magnetic vector is flipped' },

  { tag: '0018,5100', name: 'PatientPosition', vr: 'CS', description: 'Patient position descriptor relative to the equipment' },

  { tag: '0018,9087', name: 'DiffusionBValue', vr: 'FD', description: 'Diffusion b-value in sec/mm^2' },
  { tag: '0018,9089', name: 'DiffusionGradientDirectionSequence', vr: 'SQ', description: 'Sequence that describes the diffusion gradient direction' },

  { tag: '0020,0011', name: 'SeriesNumber', vr: 'IS', description: 'A number that identifies this Series' },
  { tag: '0020,0012', name: 'AcquisitionNumber', vr: 'IS', description: 'A number identifying the single continuous gathering of data' },
  { tag: '0020,0013', name: 'InstanceNumber', vr: 'IS', description: 'A number that identifies this image' },
  { tag: '0020,0032', name: 'ImagePositionPatient', vr: 'DS', description: 'The x, y, and z coordinates of the upper left hand corner of the image' },
  { tag: '0020,0037', name: 'ImageOrientationPatient', vr: 'DS', description: 'The direction cosines of the first row and the first column' },
  { tag: '0020,0052', name: 'FrameOfReferenceUID', vr: 'UI', description: 'Uniquely identifies the frame of reference for a Series' },
  { tag: '0020,1041', name: 'SliceLocation', vr: 'DS', description: 'Relative position of exposure expressed in mm' },

  { tag: '0028,0002', name: 'SamplesPerPixel', vr: 'US', description: 'Number of samples (planes) in this image' },
  { tag: '0028,0004', name: 'PhotometricInterpretation', vr: 'CS', description: 'Specifies the intended interpretation of the pixel data' },
  { tag: '0028,0010', name: 'Rows', vr: 'US', description: 'Number of rows in the image' },
  { tag: '0028,0011', name: 'Columns', vr: 'US', description: 'Number of columns in the image' },
  { tag: '0028,0030', name: 'PixelSpacing', vr: 'DS', description: 'Physical distance in the patient between the center of each pixel' },
  { tag: '0028,0100', name: 'BitsAllocated', vr: 'US', description: 'Number of bits allocated for each pixel sample' },
  { tag: '0028,0101', name: 'BitsStored', vr: 'US', description: 'Number of bits stored for each pixel sample' },
  { tag: '0028,0102', name: 'HighBit', vr: 'US', description: 'Most significant bit for pixel sample data' },
  { tag: '0028,0103', name: 'PixelRepresentation', vr: 'US', description: 'Data representation of the pixel samples' },

  // Additional fields for testing multi-value support
  { tag: '(0018,1149)', name: 'Field of View Dimension(s)', keyword: 'FieldOfViewDimensions', valueRepresentation: 'IS', valueMultiplicity: '1-2', retired: 'N', id: '00181149', vr: 'IS', description: 'Dimensions of the Image Intensifier Field of View in mm' },

  // Siemens private tags commonly used
  { tag: '0019,1028', name: 'MultibandFactor', vr: 'IS', description: 'Multiband acceleration factor (Siemens private)' },
  { tag: '0051,1011', name: 'ParallelReductionFactorInPlane', vr: 'DS', description: 'In-plane parallel imaging factor (Siemens private)' }
];

// Search/filter functions for field selection UI with efficient searching
export const searchDicomFields = async (query: string, limit: number = 50): Promise<DicomFieldDefinition[]> => {
  const fieldList = await fetchDicomFieldList();

  if (!query.trim()) {
    return fieldList.slice(0, limit);
  }

  const lowercaseQuery = query.toLowerCase();
  const results: DicomFieldDefinition[] = [];
  const exactMatches: DicomFieldDefinition[] = [];
  const startsWithMatches: DicomFieldDefinition[] = [];
  const containsMatches: DicomFieldDefinition[] = [];

  // Prioritize search results: exact matches, starts with, then contains
  for (const field of fieldList) {
    const name = field.name.toLowerCase();
    const tag = field.tag.toLowerCase();
    const keyword = field.keyword.toLowerCase();

    // Exact matches (highest priority)
    if (name === lowercaseQuery || tag === lowercaseQuery || keyword === lowercaseQuery) {
      exactMatches.push(field);
    }
    // Starts with matches (medium priority)
    else if (name.startsWith(lowercaseQuery) || keyword.startsWith(lowercaseQuery) || tag.startsWith(lowercaseQuery)) {
      startsWithMatches.push(field);
    }
    // Contains matches (lowest priority)
    else if (
      name.includes(lowercaseQuery) ||
      tag.includes(lowercaseQuery) ||
      keyword.includes(lowercaseQuery) ||
      field.description?.toLowerCase().includes(lowercaseQuery)
    ) {
      containsMatches.push(field);
    }

    // Early exit if we have enough results
    if (exactMatches.length + startsWithMatches.length + containsMatches.length >= limit * 2) {
      break;
    }
  }

  // Combine results in priority order
  const combinedResults = [...exactMatches, ...startsWithMatches, ...containsMatches];
  return combinedResults.slice(0, limit);
};

// Get field definition by tag
export const getFieldByTag = async (tag: string): Promise<DicomFieldDefinition | undefined> => {
  const fieldList = await fetchDicomFieldList();
  return fieldList.find(field => field.tag === tag);
};

// Get field definition by name
export const getFieldByName = async (name: string): Promise<DicomFieldDefinition | undefined> => {
  const fieldList = await fetchDicomFieldList();
  return fieldList.find(field => field.name === name);
};

// Get field definition by keyword
export const getFieldByKeyword = async (keyword: string): Promise<DicomFieldDefinition | undefined> => {
  const fieldList = await fetchDicomFieldList();
  return fieldList.find(field => field.keyword === keyword);
};

// Validate field tag format
export const isValidDicomTag = (tag: string): boolean => {
  const tagPattern = /^[0-9A-Fa-f]{4},[0-9A-Fa-f]{4}$/;
  return tagPattern.test(tag);
};

// Get field suggestions based on partial input
export const getFieldSuggestions = async (partialInput: string, limit: number = 10): Promise<DicomFieldDefinition[]> => {
  const searchResults = await searchDicomFields(partialInput);
  return searchResults.slice(0, limit);
};

// Categorize fields by common usage patterns
export const getFieldsByCategory = async (): Promise<{ [category: string]: DicomFieldDefinition[] }> => {
  const fieldList = await fetchDicomFieldList();

  const categories: { [key: string]: DicomFieldDefinition[] } = {
    'Patient Info': [],
    'Study Info': [],
    'Series Info': [],
    'Hardware': [],
    'Timing Parameters': [],
    'Spatial Parameters': [],
    'Image Properties': [],
    'Diffusion': [],
    'Private Tags': [],
    'Other': []
  };

  fieldList.forEach(field => {
    const tag = field.tag;
    const name = field.name.toLowerCase();

    if (tag.startsWith('0010')) {
      categories['Patient Info'].push(field);
    } else if (tag.startsWith('0008,0020') || tag.startsWith('0008,0030') || name.includes('study')) {
      categories['Study Info'].push(field);
    } else if (name.includes('series') || tag.startsWith('0020,0011')) {
      categories['Series Info'].push(field);
    } else if (name.includes('manufacturer') || name.includes('magnetic') || name.includes('coil') || name.includes('station')) {
      categories['Hardware'].push(field);
    } else if (name.includes('time') || name.includes('repetition') || name.includes('echo') || name.includes('inversion')) {
      categories['Timing Parameters'].push(field);
    } else if (name.includes('slice') || name.includes('pixel') || name.includes('position') || name.includes('orientation')) {
      categories['Spatial Parameters'].push(field);
    } else if (name.includes('image') || name.includes('bits') || name.includes('samples') || tag.startsWith('0028')) {
      categories['Image Properties'].push(field);
    } else if (name.includes('diffusion') || name.includes('bvalue')) {
      categories['Diffusion'].push(field);
    } else if (tag.match(/^[0-9A-Fa-f]{4},[0-9A-Fa-f]{4}$/) && (parseInt(tag.substring(0, 4), 16) % 2 === 1)) {
      categories['Private Tags'].push(field);
    } else {
      categories['Other'].push(field);
    }
  });

  return categories;
};

// Suggest data type based on DICOM VR (Value Representation) using enhanced mapping
export const suggestDataType = (vr: string, valueMultiplicity?: string, value?: any): FieldDataType => {
  return getDataTypeFromVR(vr, valueMultiplicity, value);
};

// Suggest validation constraint based on field characteristics using enhanced VR mapping
export const suggestValidationConstraint = (field: DicomFieldDefinition, value?: any, source?: 'dicom' | 'pro'): 'exact' | 'tolerance' | 'contains' | 'range' | 'contains_any' | 'contains_all' => {
  return getSuggestedConstraintForVR(field.vr, field.name, field.tag, source);
};

// Get field suggestions with data type and constraint recommendations
export const getEnhancedFieldSuggestions = async (partialInput: string, limit: number = 10): Promise<Array<DicomFieldDefinition & {
  suggestedDataType: FieldDataType;
  suggestedConstraint: 'exact' | 'tolerance' | 'contains' | 'range' | 'contains_any' | 'contains_all';
}>> => {
  const searchResults = await searchDicomFields(partialInput, limit);

  return searchResults.map(field => ({
    ...field,
    suggestedDataType: suggestDataType(field.vr, field.valueMultiplicity),
    suggestedConstraint: suggestValidationConstraint(field)
  }));
};