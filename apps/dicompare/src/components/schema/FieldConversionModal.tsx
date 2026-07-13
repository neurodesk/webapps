import React, { useState } from 'react';
import { X, List, Layers } from 'lucide-react';

interface FieldConversionModalProps {
  isOpen: boolean;
  fieldName: string;
  fieldValue: any[];
  onClose: () => void;
  onConvert: (mode: 'separate-series' | 'single-series') => void;
}

const FieldConversionModal: React.FC<FieldConversionModalProps> = ({
  isOpen,
  fieldName,
  fieldValue,
  onClose,
  onConvert
}) => {
  const [selectedMode, setSelectedMode] = useState<'separate-series' | 'single-series'>('single-series');

  if (!isOpen) return null;

  const handleConvert = () => {
    onConvert(selectedMode);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            Convert "{fieldName}" to Series Field
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-4">
          <p className="text-sm text-gray-600 mb-3">
            This field has multiple values: <span className="font-mono text-xs bg-gray-100 px-1 rounded">
              [{fieldValue.slice(0, 3).map(v => String(v)).join(', ')}{fieldValue.length > 3 ? ', ...' : ''}]
            </span>
          </p>
          <p className="text-sm text-gray-600 mb-4">
            How would you like to convert it to a series-level field?
          </p>
        </div>

        <div className="space-y-3 mb-6">
          <label className="flex items-start space-x-3 cursor-pointer">
            <input
              type="radio"
              name="conversion-mode"
              value="single-series"
              checked={selectedMode === 'single-series'}
              onChange={(e) => setSelectedMode(e.target.value as 'single-series')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center space-x-2">
                <List className="h-4 w-4 text-blue-600" />
                <span className="font-medium text-gray-900">Single Series with Full List</span>
              </div>
              <p className="text-sm text-gray-600 mt-1">
                Create series with the complete list as the field value. Default 2 series minimum.
              </p>
            </div>
          </label>

          <label className="flex items-start space-x-3 cursor-pointer">
            <input
              type="radio"
              name="conversion-mode"
              value="separate-series"
              checked={selectedMode === 'separate-series'}
              onChange={(e) => setSelectedMode(e.target.value as 'separate-series')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center space-x-2">
                <Layers className="h-4 w-4 text-green-600" />
                <span className="font-medium text-gray-900">Separate Series for Each Value</span>
              </div>
              <p className="text-sm text-gray-600 mt-1">
                Create {fieldValue.length} series, one for each value in the list.
              </p>
            </div>
          </label>
        </div>

        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConvert}
            className="px-4 py-2 bg-medical-600 text-white rounded-md text-sm font-medium hover:bg-medical-700"
          >
            Convert Field
          </button>
        </div>
      </div>
    </div>
  );
};

export default FieldConversionModal;