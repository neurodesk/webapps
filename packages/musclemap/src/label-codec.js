export const MuscleMapLabelCodec = (() => {
  const AUTO_ENCODING = 'auto';
  const SPARSE_ENCODING = 'sparse';
  const CLASS_INDEX_ENCODING = 'class-index';
  const OPENRECON_ENCODING = 'openrecon-int12';
  const CONCRETE_ENCODINGS = [SPARSE_ENCODING, CLASS_INDEX_ENCODING, OPENRECON_ENCODING];
  const MAX_LABEL_VALUE = 65535;
  const MAX_ERROR_VALUES = 8;

  class LabelCodecError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'LabelCodecError';
      this.code = code;
      Object.assign(this, details);
    }
  }

  function toOpenReconInt12(value) {
    return 3 * Math.floor(value / 10) + (value % 10);
  }

  function encodingLabel(encoding) {
    switch (encoding) {
      case SPARSE_ENCODING:
        return 'official sparse';
      case CLASS_INDEX_ENCODING:
        return 'class-index';
      case OPENRECON_ENCODING:
        return 'OpenRecon int12';
      default:
        return encoding;
    }
  }

  function inspectObservedValues(values) {
    const seen = new Uint8Array(MAX_LABEL_VALUE + 1);
    const observed = [];
    for (let offset = 0; offset < values.length; offset++) {
      const value = values[offset];
      if (!Number.isFinite(value)) {
        throw new LabelCodecError('non-finite-label', `Invalid label value ${value} at voxel ${offset}`);
      }
      if (!Number.isInteger(value)) {
        throw new LabelCodecError('non-integer-label', `Label value ${value} at voxel ${offset} is not an integer`);
      }
      if (value < 0) {
        throw new LabelCodecError('negative-label', `Label value ${value} at voxel ${offset} is negative`);
      }
      if (value > MAX_LABEL_VALUE) {
        throw new LabelCodecError(
          'unknown-label',
          `Label value ${value} at voxel ${offset} exceeds the supported NIfTI label range`
        );
      }
      if (!seen[value]) {
        seen[value] = 1;
        observed.push(value);
      }
    }
    observed.sort((left, right) => left - right);
    return observed;
  }

  function createLabelCodec(labelSpace) {
    if (!labelSpace || !Array.isArray(labelSpace.labels) ||
        !Number.isInteger(labelSpace.classCount) || labelSpace.classCount < 1 || labelSpace.classCount > 256 ||
        !['uint8', 'uint16'].includes(labelSpace.externalEncoding)) {
      throw new Error('A valid MuscleMap label space is required');
    }

    const indexToValue = new Uint16Array(labelSpace.classCount);
    const seenIndices = new Set();
    const valueToIndex = new Map();
    for (const label of labelSpace.labels) {
      if (!Number.isInteger(label.index) || label.index < 0 || label.index >= labelSpace.classCount) {
        throw new Error(`Invalid class index ${label.index} in ${labelSpace.id}`);
      }
      if (!Number.isInteger(label.value) || label.value < 0 || label.value > 65535) {
        throw new Error(`Invalid external value ${label.value} in ${labelSpace.id}`);
      }
      if (valueToIndex.has(label.value)) {
        throw new Error(`Duplicate external value ${label.value} in ${labelSpace.id}`);
      }
      if (seenIndices.has(label.index)) {
        throw new Error(`Duplicate class index ${label.index} in ${labelSpace.id}`);
      }
      seenIndices.add(label.index);
      indexToValue[label.index] = label.value;
      valueToIndex.set(label.value, label.index);
    }
    if (seenIndices.size !== labelSpace.classCount) {
      throw new Error(`Incomplete class indices in ${labelSpace.id}`);
    }

    let openReconValueToIndex = new Map();
    for (const label of labelSpace.labels) {
      const mappedValue = toOpenReconInt12(label.value);
      const priorIndex = openReconValueToIndex.get(mappedValue);
      if ((label.value % 10) > 2 || mappedValue > 4095 ||
          (priorIndex !== undefined && priorIndex !== label.index)) {
        openReconValueToIndex = null;
        break;
      }
      openReconValueToIndex.set(mappedValue, label.index);
    }

    const decoders = new Map([
      [SPARSE_ENCODING, {
        encoding: SPARSE_ENCODING,
        lookup: value => valueToIndex.get(value)
      }],
      [CLASS_INDEX_ENCODING, {
        encoding: CLASS_INDEX_ENCODING,
        lookup: value => value < labelSpace.classCount ? value : undefined
      }]
    ]);
    if (openReconValueToIndex) {
      decoders.set(OPENRECON_ENCODING, {
        encoding: OPENRECON_ENCODING,
        lookup: value => openReconValueToIndex.get(value)
      });
    }

    function encode(indices) {
      const output = labelSpace.externalEncoding === 'uint16'
        ? new Uint16Array(indices.length)
        : new Uint8Array(indices.length);
      for (let offset = 0; offset < indices.length; offset++) {
        const index = indices[offset];
        if (!Number.isInteger(index) || index < 0 || index >= labelSpace.classCount) {
          throw new Error(`Unknown class index ${index} for ${labelSpace.id}`);
        }
        output[offset] = indexToValue[index];
      }
      return output;
    }

    function supportsEncoding(encoding) {
      return encoding === AUTO_ENCODING || decoders.has(encoding);
    }

    function manualDecoder(observed, encoding) {
      const decoder = decoders.get(encoding);
      if (!decoder) {
        throw new LabelCodecError(
          'unsupported-encoding',
          `${encodingLabel(encoding)} labels are not supported for ${labelSpace.id}`
        );
      }

      const unknownValue = observed.find(value => decoder.lookup(value) === undefined);
      if (unknownValue !== undefined) {
        const message = encoding === SPARSE_ENCODING
          ? `Unknown external label value ${unknownValue} for ${labelSpace.id}`
          : encoding === CLASS_INDEX_ENCODING
            ? `Unknown class index ${unknownValue} for ${labelSpace.id}`
            : `Unknown OpenRecon int12 label value ${unknownValue} for ${labelSpace.id}`;
        throw new LabelCodecError('unknown-label', message, { observedValues: [unknownValue] });
      }
      return decoder;
    }

    function compatibleDecoders(observed) {
      return [...decoders.values()].filter(
        decoder => observed.every(value => decoder.lookup(value) !== undefined)
      );
    }

    function sameObservedMeaning(left, right, observed) {
      return observed.every(value => left.lookup(value) === right.lookup(value));
    }

    function automaticDecoder(observed) {
      const compatible = compatibleDecoders(observed);
      if (compatible.length === 0) {
        const examples = observed
          .filter(value => [...decoders.values()].every(decoder => decoder.lookup(value) === undefined))
          .slice(0, MAX_ERROR_VALUES);
        const valuesText = (examples.length ? examples : observed.slice(0, MAX_ERROR_VALUES)).join(', ');
        throw new LabelCodecError(
          'unknown-label',
          `Segmentation labels do not match ${labelSpace.id}. Unsupported value${valuesText.includes(',') ? 's' : ''}: ${valuesText}`,
          { observedValues: examples }
        );
      }

      const reference = compatible[0];
      const equivalent = compatible.every(
        decoder => sameObservedMeaning(reference, decoder, observed)
      );
      if (!equivalent) {
        const validEncodings = compatible.map(decoder => decoder.encoding);
        throw new LabelCodecError(
          'ambiguous-encoding',
          `Segmentation labels are ambiguous between ${validEncodings.map(encodingLabel).join(' and ')} values for ${labelSpace.id}. Choose the encoding manually.`,
          { validEncodings }
        );
      }

      if (compatible.length > 1) {
        return {
          decoder: reference,
          resolution: {
            kind: 'equivalent',
            encodings: compatible.map(decoder => decoder.encoding)
          },
          summary: `Labels decoded unambiguously for ${labelSpace.id}; source encoding is indeterminate (${compatible.map(encodingLabel).join(', ')} values are equivalent).`
        };
      }

      const encoding = reference.encoding;
      const summary = encoding === OPENRECON_ENCODING
        ? `Detected OpenRecon int12 labels for ${labelSpace.id}; restored official MuscleMap label mapping.`
        : `Detected ${encodingLabel(encoding)} labels for ${labelSpace.id}.`;
      return {
        decoder: reference,
        resolution: { kind: 'resolved', encoding },
        summary
      };
    }

    function normalizeSegmentation(values, requestedEncoding = AUTO_ENCODING) {
      if (requestedEncoding !== AUTO_ENCODING && !CONCRETE_ENCODINGS.includes(requestedEncoding)) {
        throw new LabelCodecError(
          'unsupported-encoding',
          'Label encoding must be auto, sparse, class-index, or openrecon-int12'
        );
      }

      const observed = inspectObservedValues(values);
      let selected;
      if (requestedEncoding === AUTO_ENCODING) {
        selected = automaticDecoder(observed);
      } else {
        const decoder = manualDecoder(observed, requestedEncoding);
        selected = {
          decoder,
          resolution: { kind: 'resolved', encoding: requestedEncoding, manual: true },
          summary: `Using manually selected ${encodingLabel(requestedEncoding)} labels for ${labelSpace.id}.`
        };
      }

      const indices = new Uint8Array(values.length);
      for (let offset = 0; offset < values.length; offset++) {
        indices[offset] = selected.decoder.lookup(values[offset]);
      }
      return {
        indices,
        resolution: selected.resolution,
        summary: selected.summary
      };
    }

    function decode(values, encoding) {
      if (encoding == null) {
        throw new Error('Label encoding must be auto, sparse, class-index, or openrecon-int12');
      }
      return normalizeSegmentation(values, encoding).indices;
    }

    return {
      encode,
      decode,
      normalizeSegmentation,
      supportsEncoding,
      supportedEncodings: [AUTO_ENCODING, ...decoders.keys()],
      indexToValue,
      valueToIndex
    };
  }

  function sameGeometry(left, right, tolerance) {
    const epsilon = tolerance ?? 1e-5;
    if (!left || !right || left.dims.length !== right.dims.length || left.affine.length !== right.affine.length) {
      return false;
    }
    if (left.dims.some((value, index) => value !== right.dims[index])) return false;
    for (let row = 0; row < left.affine.length; row++) {
      for (let column = 0; column < left.affine[row].length; column++) {
        if (Math.abs(left.affine[row][column] - right.affine[row][column]) > epsilon) return false;
      }
    }
    return true;
  }

  return {
    AUTO_ENCODING,
    SPARSE_ENCODING,
    CLASS_INDEX_ENCODING,
    OPENRECON_ENCODING,
    LabelCodecError,
    createLabelCodec,
    sameGeometry,
    toOpenReconInt12
  };
})();
