import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useWorkspace } from './WorkspaceContext';
import { ADD_NEW_ID, ADD_FROM_DATA_ID, SCHEMA_INFO_ID, ASSIGN_DATA_ID } from '../components/workspace/WorkspaceSidebar';

export type TutorialId = 'compare' | 'validate' | 'create' | 'import';

// Branch types for tutorials with conditional flows
type TutorialBranch = 'single' | 'multi' | null;

// Special navigation targets
const FIRST_ITEM = '__first_item__';
const FIRST_MATCHED_ITEM = '__first_matched_item__'; // First item with both reference and data

interface TutorialContextValue {
  activeTutorial: TutorialId | null;
  startTutorial: (id: TutorialId) => void;
  stopTutorial: () => void;
  isRunning: boolean;
}

const TutorialContext = createContext<TutorialContextValue | null>(null);

export const useTutorial = () => {
  const context = useContext(TutorialContext);
  if (!context) {
    throw new Error('useTutorial must be used within a TutorialProvider');
  }
  return context;
};

// Condition types for waiting
type WaitCondition =
  | { type: 'selectedItem'; value: string }
  | { type: 'hasItems'; minCount: number }
  | { type: 'hasItemWithData' }
  | { type: 'hasItemWithSchema' }
  | { type: 'hasStandaloneTestData' } // Has test data items not yet assigned to references
  | { type: 'hasSchemaItems' } // Has schema-sourced items in workspace
  | { type: 'hasMatchedData' } // Has items with both reference and data matched
  | { type: 'hasItemSelected' } // An actual workspace item (not a panel) is selected
  | { type: 'elementExists'; selector: string } // DOM element exists
  | { type: 'elementNotExists'; selector: string } // DOM element does not exist
  | { type: 'noneOrMatchedData' } // Manual advance OR hasMatchedData (for skippable steps)
  | { type: 'noneOrElementExists'; selector: string } // Manual advance OR element exists
  | { type: 'scoresComputedOrMatchedData' } // Scores computed OR schema selected
  | { type: 'none' }; // No wait - manual advance

type Placement = 'top' | 'bottom' | 'left' | 'right';

// Tutorial step definition
interface TutorialStep {
  target: string;
  content: string;
  placement?: Placement;
  waitFor?: WaitCondition;
}

// Compare tutorial steps - single item flow (user uploaded 1 acquisition)
const compareStepsSingle: TutorialStep[] = [
  {
    target: '[data-tutorial="from-data-button"]',
    content: 'Click "From data" to open the data upload panel.',
    placement: 'right',
    waitFor: { type: 'selectedItem', value: ADD_FROM_DATA_ID },
  },
  {
    target: '[data-tutorial="reference-dropzone"]',
    content: 'Drop your reference files here. These define the expected values.',
    placement: 'right',
    waitFor: { type: 'hasItems', minCount: 1 },
  },
  {
    target: '[data-tutorial="item-test-data-dropzone"]',
    content: 'Now drop your test data here. This is what will be compared against the reference.',
    placement: 'left',
    waitFor: { type: 'hasItemWithData' },
  },
  {
    target: '[data-tutorial="print-button"]',
    content: 'The comparison results are shown below. Use Print to generate a formatted report of the differences.',
    placement: 'bottom',
    waitFor: { type: 'none' },
  },
];

// Compare tutorial steps - multi item flow (user uploaded multiple acquisitions)
const compareStepsMulti: TutorialStep[] = [
  {
    target: '[data-tutorial="from-data-button"]',
    content: 'Click "From data" to open the data upload panel.',
    placement: 'right',
    waitFor: { type: 'selectedItem', value: ADD_FROM_DATA_ID },
  },
  {
    target: '[data-tutorial="reference-dropzone"]',
    content: 'Drop your reference files here. These define the expected values.',
    placement: 'right',
    waitFor: { type: 'hasItems', minCount: 1 },
  },
  {
    target: '[data-tutorial="test-data-dropzone"]',
    content: 'Multiple acquisitions detected! Now drop your test data here. All test acquisitions will be uploaded at once.',
    placement: 'left',
    waitFor: { type: 'hasStandaloneTestData' },
  },
  {
    target: '[data-tutorial="assign-button"]',
    content: 'When you are ready, click "Assign data to references" to open the matching panel.',
    placement: 'right',
    waitFor: { type: 'elementExists', selector: '[data-tutorial="matching-panel"]' },
  },
  {
    target: '[data-tutorial="auto-match-button"]',
    content: 'Click "Auto-match All" to automatically pair test data with the correct reference acquisitions.',
    placement: 'bottom',
    waitFor: { type: 'hasMatchedData' },
  },
  {
    target: '[data-tutorial="matched-item"]',
    content: 'Click on a matched acquisition to view the comparison results.',
    placement: 'right',
    waitFor: { type: 'hasItemSelected' },
  },
  {
    target: '[data-tutorial="print-button"]',
    content: 'Use Print to generate a formatted comparison report.',
    placement: 'bottom',
    waitFor: { type: 'none' },
  },
];

// Validate tutorial steps - single item flow (user uploaded 1 acquisition)
const validateStepsSingle: TutorialStep[] = [
  {
    target: '[data-tutorial="from-data-button"]',
    content: 'Click "From data" to upload the files you want to validate.',
    placement: 'right',
    waitFor: { type: 'selectedItem', value: ADD_FROM_DATA_ID },
  },
  {
    target: '[data-tutorial="test-data-dropzone"]',
    content: 'Drop your files here. These are the files you want to check for compliance.',
    placement: 'left',
    waitFor: { type: 'hasItems', minCount: 1 },
  },
  // Note: Step to click acquisition removed - app auto-selects single uploaded items
  {
    target: '[data-tutorial="library-button"]',
    content: 'Click "Library" to open the schema browser.',
    placement: 'top',
    waitFor: { type: 'elementExists', selector: '[data-tutorial="attach-schema-modal"]' },
  },
  {
    target: '[data-tutorial="find-best-matches-button"]',
    content: 'Click "Find best matches" to identify schemas that match your data, or browse the list and select one directly.',
    placement: 'bottom',
    waitFor: { type: 'scoresComputedOrMatchedData' },
  },
  {
    target: '[data-tutorial="attach-schema-modal"]',
    content: 'Select a schema acquisition from the list to attach it as your reference.',
    placement: 'left',
    waitFor: { type: 'hasMatchedData' },
  },
  {
    target: '[data-tutorial="print-button"]',
    content: 'The validation results are shown below. Use Print to generate a formatted compliance report.',
    placement: 'bottom',
    waitFor: { type: 'none' },
  },
];

// Validate tutorial steps - multi item flow (user uploaded multiple acquisitions)
const validateStepsMulti: TutorialStep[] = [
  {
    target: '[data-tutorial="from-data-button"]',
    content: 'Click "From data" to upload the files you want to validate.',
    placement: 'right',
    waitFor: { type: 'selectedItem', value: ADD_FROM_DATA_ID },
  },
  {
    target: '[data-tutorial="test-data-dropzone"]',
    content: 'Drop your files here. These are the files you want to check for compliance.',
    placement: 'left',
    waitFor: { type: 'hasItems', minCount: 1 },
  },
  {
    target: '[data-tutorial="from-schema-button"]',
    content: 'Multiple acquisitions detected! Click "From schema" to browse available reference schemas.',
    placement: 'right',
    waitFor: { type: 'selectedItem', value: ADD_NEW_ID },
  },
  {
    target: '[data-tutorial="sidebar-drop-zone"]',
    content: 'Drag relevant schemas from the library into your workspace. Add schemas that match your acquisitions.',
    placement: 'right',
    waitFor: { type: 'hasSchemaItems' },
  },
  {
    target: '[data-tutorial="assign-button"]',
    content: 'When you are ready, click "Assign data to references" to match your test data to the reference schemas.',
    placement: 'right',
    waitFor: { type: 'elementExists', selector: '[data-tutorial="matching-panel"]' },
  },
  {
    target: '[data-tutorial="auto-match-button"]',
    content: 'Click "Auto-match All" to automatically pair test data with the correct reference schemas.',
    placement: 'bottom',
    waitFor: { type: 'hasMatchedData' },
  },
  {
    target: '[data-tutorial="matched-item"]',
    content: 'Click on a matched acquisition to view the validation results.',
    placement: 'right',
    waitFor: { type: 'hasItemSelected' },
  },
  {
    target: '[data-tutorial="print-button"]',
    content: 'Use Print to generate a formatted compliance report.',
    placement: 'bottom',
    waitFor: { type: 'none' },
  },
];

// Static tutorial step definitions (non-branching tutorials)
const staticTutorialSteps: Partial<Record<TutorialId, TutorialStep[]>> = {
  create: [
    {
      target: '[data-tutorial="from-data-button"]',
      content: 'Click "From data" to start creating your schema.',
      placement: 'right',
      waitFor: { type: 'selectedItem', value: ADD_FROM_DATA_ID },
    },
    {
      target: '[data-tutorial="reference-dropzone"]',
      content: 'Drop files here to auto-extract fields, or click "+ Blank" to create an empty reference.',
      placement: 'right',
      waitFor: { type: 'hasItems', minCount: 1 },
    },
    // After upload, app auto-selects the item. User needs to click Edit to enter edit mode:
    {
      target: '[data-tutorial="edit-button"]',
      content: 'Click Edit to start customizing this acquisition. You can modify field values, add tolerances, and configure validation rules.',
      placement: 'bottom',
      waitFor: { type: 'elementExists', selector: '[data-tutorial="acquisition-name-input"]' },
    },
    // Now in edit mode, show the editing features:
    {
      target: '[data-tutorial="acquisition-name-input"]',
      content: 'Give your acquisition a descriptive name. This helps identify it when validating data later.',
      placement: 'bottom',
      waitFor: { type: 'none' },
    },
    {
      target: '[data-tutorial="acquisition-description-input"]',
      content: 'Add a short description to explain what this acquisition captures (e.g., "T1-weighted structural scan").',
      placement: 'bottom',
      waitFor: { type: 'none' },
    },
    {
      target: '[data-tutorial="readme-button"]',
      content: 'Click README to add detailed documentation in Markdown format. Great for explaining acquisition requirements to your team.',
      placement: 'left',
      waitFor: { type: 'none' },
    },
    {
      target: '[data-tutorial="add-dicom-fields"]',
      content: 'Use this search box to add additional DICOM fields to check. Type a field name like "EchoTime" or "FlipAngle".',
      placement: 'bottom',
      // Shows Next if fields exist, otherwise waits for user to add a field
      waitFor: { type: 'noneOrElementExists', selector: '[data-tutorial="field-table"]' },
    },
    {
      target: '[data-tutorial="field-value-cell"]',
      content: 'Click on any value cell to edit it. You can set exact values, ranges, or use pattern matching.',
      placement: 'left',
      waitFor: { type: 'none' },
    },
    {
      target: '[data-tutorial="convert-to-series-button"]',
      content: 'Use "Convert to series field" if a value varies across series (e.g., EchoTime in multi-echo sequences).',
      placement: 'left',
      waitFor: { type: 'none' },
    },
    {
      target: '[data-tutorial="add-validator-button"]',
      content: 'Add custom validation functions for complex rules like "SliceThickness must be less than 2mm" or cross-field checks.',
      placement: 'left',
      waitFor: { type: 'none' },
    },
    {
      target: '[data-tutorial="save-button"]',
      content: 'When ready, click Save to add schema metadata, then save to your library or download as JSON.',
      placement: 'bottom',
      waitFor: { type: 'selectedItem', value: SCHEMA_INFO_ID },
    },
  ],
  import: [
    {
      target: '[data-tutorial="from-schema-button"]',
      content: 'Click "From schema" to open the schema browser.',
      placement: 'right',
      waitFor: { type: 'selectedItem', value: ADD_NEW_ID },
    },
    {
      target: '[data-tutorial="schema-upload"]',
      content: 'Drag a JSON schema file here or click to browse. Your imported schemas appear under "Custom".',
      placement: 'bottom',
      waitFor: { type: 'none' },
    },
    {
      target: '[data-tutorial="sidebar-drop-zone"]',
      content: 'Drag acquisitions from the schema browser into your workspace to start using them.',
      placement: 'right',
      waitFor: { type: 'hasItems', minCount: 1 },
    },
  ],
};

// Navigation for single-item compare flow
const compareNavigationSingle: Record<number, string> = {
  1: ADD_FROM_DATA_ID, // Stay on From data for reference dropzone
  2: FIRST_ITEM, // Select the first item to show its test data dropzone
  // Step 3 (print button) - item already selected from step 2
};

// Navigation for multi-item compare flow
const compareNavigationMulti: Record<number, string> = {
  1: ADD_FROM_DATA_ID, // Stay on From data for reference dropzone
  2: ADD_FROM_DATA_ID, // Stay on From data for test data dropzone
  // Step 3 (assign button) - no navigation needed, button is always visible
  // Step 4 (auto-match) - matching panel already selected
  // Step 5 (click matched item) - user clicks, no auto-navigation
  // Step 6 (print button) - item selected by user in step 5
};

// Navigation for single-item validate flow
const validateNavigationSingle: Record<number, string> = {
  1: ADD_FROM_DATA_ID, // Stay on From data for test data dropzone
  // Step 2 (library button) - app auto-selects uploaded item
  // Steps 3-5 (find matches, select schema, print) - no nav needed
};

// Navigation for multi-item validate flow
const validateNavigationMulti: Record<number, string> = {
  1: ADD_FROM_DATA_ID, // Stay on From data for test data dropzone
  // Step 2 (from schema button) - no navigation needed
  // Step 3 (drag schemas) - schema library already selected
  // Step 4 (assign button) - no navigation needed
  // Step 5 (auto-match) - matching panel already selected
  // Step 6 (click matched item) - user clicks
  // Step 7 (print button) - item selected by user
};

// Navigation for static tutorials
const staticStepNavigation: Partial<Record<TutorialId, Record<number, string>>> = {
  create: {
    1: ADD_FROM_DATA_ID, // Stay on From data for reference dropzone
    2: FIRST_ITEM, // Select first item for Edit button
    3: FIRST_ITEM, // Select first item for acquisition name editing
    4: FIRST_ITEM, // Select first item for description editing
    5: FIRST_ITEM, // Select first item for README button
    6: FIRST_ITEM, // Select first item for Add DICOM fields
    7: FIRST_ITEM, // Select first item for field value editing
    8: FIRST_ITEM, // Select first item for convert to series
    9: FIRST_ITEM, // Select first item for add validator
    // Step 10 (save) - no nav needed, user clicks it
  },
  import: {},
};

// Simple tooltip component
const TutorialTooltip: React.FC<{
  step: TutorialStep;
  stepIndex: number;
  totalSteps: number;
  onNext: () => void;
  onSkip: () => void;
  hasWaitCondition: boolean;
}> = ({ step, stepIndex, totalSteps, onNext, onSkip, hasWaitCondition }) => {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [arrowPosition, setArrowPosition] = useState<{ side: Placement; offset: number }>({ side: 'left', offset: 50 });
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updatePosition = () => {
      const target = document.querySelector(step.target);
      if (!target) {
        setPosition(null);
        return;
      }

      const rect = target.getBoundingClientRect();
      const tooltipWidth = 320;
      const tooltipHeight = tooltipRef.current?.offsetHeight || 150;
      const padding = 12;
      const arrowSize = 10;

      let top = 0;
      let left = 0;
      let side: Placement = step.placement || 'right';

      // Calculate position based on placement
      switch (side) {
        case 'right':
          top = rect.top + rect.height / 2 - tooltipHeight / 2;
          left = rect.right + padding + arrowSize;
          break;
        case 'left':
          top = rect.top + rect.height / 2 - tooltipHeight / 2;
          left = rect.left - tooltipWidth - padding - arrowSize;
          break;
        case 'bottom':
          top = rect.bottom + padding + arrowSize;
          left = rect.left + rect.width / 2 - tooltipWidth / 2;
          break;
        case 'top':
          top = rect.top - tooltipHeight - padding - arrowSize;
          left = rect.left + rect.width / 2 - tooltipWidth / 2;
          break;
      }

      // Keep tooltip in viewport
      const viewportPadding = 16;
      if (left < viewportPadding) left = viewportPadding;
      if (left + tooltipWidth > window.innerWidth - viewportPadding) {
        left = window.innerWidth - tooltipWidth - viewportPadding;
      }
      if (top < viewportPadding) top = viewportPadding;
      if (top + tooltipHeight > window.innerHeight - viewportPadding) {
        top = window.innerHeight - tooltipHeight - viewportPadding;
      }

      setPosition({ top, left });
      setArrowPosition({ side, offset: 50 });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    // Also update periodically in case target moves
    const interval = setInterval(updatePosition, 200);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      clearInterval(interval);
    };
  }, [step.target, step.placement]);

  if (!position) return null;

  const arrowStyles: Record<Placement, React.CSSProperties> = {
    right: { left: -10, top: '50%', transform: 'translateY(-50%)', width: 10, height: 18, clipPath: 'polygon(0 50%, 100% 0, 100% 100%)' },
    left: { right: -10, top: '50%', transform: 'translateY(-50%)', width: 10, height: 18, clipPath: 'polygon(0 0, 100% 50%, 0 100%)' },
    bottom: { top: -10, left: '50%', transform: 'translateX(-50%)', width: 18, height: 10, clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' },
    top: { bottom: -10, left: '50%', transform: 'translateX(-50%)', width: 18, height: 10, clipPath: 'polygon(0 0, 100% 0, 50% 100%)' },
  };

  return createPortal(
    <div
      ref={tooltipRef}
      className="fixed z-[10001] w-80 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border-2 border-brand-500 dark:border-brand-400"
      style={{ top: position.top, left: position.left }}
    >
      {/* Arrow */}
      <div
        className="absolute bg-brand-500 dark:bg-brand-400"
        style={arrowStyles[arrowPosition.side]}
      />

      {/* Content */}
      <div className="p-4">
        <div className="flex items-start justify-between mb-2">
          <span className="text-xs font-medium text-brand-600 dark:text-brand-400">
            Step {stepIndex + 1} of {totalSteps}
          </span>
          <button
            onClick={onSkip}
            className="p-1 -m-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
          {step.content}
        </p>

        <div className="flex items-center justify-between">
          <button
            onClick={onSkip}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Skip tutorial
          </button>

          {!hasWaitCondition && (
            <button
              onClick={onNext}
              className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
            >
              {stepIndex === totalSteps - 1 ? 'Done' : 'Next'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export const TutorialProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeTutorial, setActiveTutorial] = useState<TutorialId | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [tutorialBranch, setTutorialBranch] = useState<TutorialBranch>(null);
  const workspace = useWorkspace();

  // Get steps and navigation based on tutorial type and branch
  const { steps, navigation } = useMemo(() => {
    if (!activeTutorial) return { steps: [], navigation: {} };

    if (activeTutorial === 'compare') {
      if (tutorialBranch === 'multi') {
        return { steps: compareStepsMulti, navigation: compareNavigationMulti };
      } else {
        return { steps: compareStepsSingle, navigation: compareNavigationSingle };
      }
    }

    if (activeTutorial === 'validate') {
      if (tutorialBranch === 'multi') {
        return { steps: validateStepsMulti, navigation: validateNavigationMulti };
      } else {
        return { steps: validateStepsSingle, navigation: validateNavigationSingle };
      }
    }

    // For other tutorials, use static definitions
    return {
      steps: staticTutorialSteps[activeTutorial] || [],
      navigation: staticStepNavigation[activeTutorial] || {},
    };
  }, [activeTutorial, tutorialBranch]);

  // Get current step and its wait condition
  const currentStep = steps[stepIndex] || null;
  const waitCondition = currentStep?.waitFor;
  const totalSteps = steps.length;

  // Periodic tick for DOM-based condition checks
  const [domCheckTick, setDomCheckTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const needsDomCheck = waitCondition?.type === 'elementExists' ||
                          waitCondition?.type === 'elementNotExists' ||
                          waitCondition?.type === 'noneOrElementExists' ||
                          waitCondition?.type === 'scoresComputedOrMatchedData';
    if (!needsDomCheck) return;
    const interval = setInterval(() => setDomCheckTick(t => t + 1), 200);
    return () => clearInterval(interval);
  }, [isRunning, waitCondition?.type]);

  // Navigate to required panel when step changes, and keep it selected
  const navTarget = navigation[stepIndex];

  // Get first item ID for FIRST_ITEM navigation
  const firstItemId = workspace.items[0]?.id;

  // Get first matched item ID (item with both reference and data)
  const firstMatchedItemId = useMemo(() => {
    const matchedItem = workspace.items.find(item =>
      // Has attached data (reference item with data attached)
      item.attachedData !== undefined ||
      // OR is a validation-subject with attached schema
      (item.source === 'data' && item.dataUsageMode === 'validation-subject' && item.attachedSchema !== undefined)
    );
    return matchedItem?.id;
  }, [workspace.items]);

  // Determine tutorial branch based on workspace state
  // Can switch from 'single' to 'multi' if multiple items are uploaded
  useEffect(() => {
    if (!isRunning) return;
    if (activeTutorial !== 'compare' && activeTutorial !== 'validate') return;

    // Count reference items (schema-template or schema-sourced)
    const referenceItems = workspace.items.filter(item =>
      item.source === 'schema' ||
      (item.source === 'data' && item.dataUsageMode === 'schema-template')
    );

    // Count standalone test data items (validation-subject without attached schema)
    const standaloneTestItems = workspace.items.filter(item =>
      item.source === 'data' &&
      item.dataUsageMode === 'validation-subject' &&
      !item.attachedSchema
    );

    let needsMultiFlow = false;

    if (activeTutorial === 'compare') {
      // Compare: multi if multiple refs, multiple test data, or both exist
      needsMultiFlow = referenceItems.length > 1 || standaloneTestItems.length > 1 ||
        (referenceItems.length >= 1 && standaloneTestItems.length >= 1);
    } else if (activeTutorial === 'validate') {
      // Validate: multi if multiple test data items uploaded
      needsMultiFlow = standaloneTestItems.length > 1;
    }

    if (tutorialBranch === null && workspace.items.length > 0 && stepIndex >= 1) {
      // Initial branch determination
      setTutorialBranch(needsMultiFlow ? 'multi' : 'single');
    } else if (tutorialBranch === 'single' && needsMultiFlow) {
      // Switch from single to multi if conditions change
      setTutorialBranch('multi');
    }
  }, [activeTutorial, isRunning, tutorialBranch, workspace.items, stepIndex]);

  // Check if wait condition is satisfied
  const isConditionMet = useMemo(() => {
    if (!waitCondition || !isRunning) return false;

    switch (waitCondition.type) {
      case 'selectedItem':
        return workspace.selectedId === waitCondition.value;
      case 'hasItems':
        return workspace.items.length >= waitCondition.minCount;
      case 'hasItemWithData':
        return workspace.items.some(item =>
          item.attachedData !== undefined ||
          (item.source === 'data' && item.dataUsageMode === 'validation-subject')
        );
      case 'hasItemWithSchema':
        return workspace.items.some(item =>
          item.attachedSchema !== undefined ||
          item.source === 'schema' ||
          (item.source === 'data' && item.dataUsageMode === 'schema-template')
        );
      case 'hasStandaloneTestData':
        // Check if there are validation-subject items (test data not yet assigned)
        return workspace.items.some(item =>
          item.source === 'data' && item.dataUsageMode === 'validation-subject'
        );
      case 'hasSchemaItems':
        // Check if there are schema-sourced items in the workspace
        return workspace.items.some(item => item.source === 'schema');
      case 'hasMatchedData':
        // Check if any item has both reference and data matched
        return workspace.items.some(item =>
          (item.attachedData !== undefined) ||
          (item.source === 'data' && item.dataUsageMode === 'validation-subject' && item.attachedSchema !== undefined)
        );
      case 'hasItemSelected':
        // Check if an actual workspace item is selected (not a special panel)
        return workspace.selectedId !== null &&
          !workspace.selectedId.startsWith('__') &&
          workspace.items.some(item => item.id === workspace.selectedId);
      case 'elementExists':
        // Check if a DOM element matching the selector exists
        return document.querySelector(waitCondition.selector) !== null;
      case 'elementNotExists':
        // Check if a DOM element matching the selector does NOT exist
        return document.querySelector(waitCondition.selector) === null;
      case 'noneOrMatchedData':
        // Auto-advance if hasMatchedData, otherwise allow manual Next button
        // This is for steps that can be skipped if user completes the action early
        return workspace.items.some(item =>
          (item.attachedData !== undefined) ||
          (item.source === 'data' && item.dataUsageMode === 'validation-subject' && item.attachedSchema !== undefined)
        );
      case 'noneOrElementExists':
        // Auto-advance if element exists, otherwise allow manual Next button
        // Useful for steps that can be skipped if target already exists
        return document.querySelector(waitCondition.selector) !== null;
      case 'scoresComputedOrMatchedData':
        // Auto-advance if scores computed OR schema selected
        const scoresComputed = document.querySelector('[data-tutorial="scores-computed"]') !== null;
        const hasMatched = workspace.items.some(item =>
          (item.attachedData !== undefined) ||
          (item.source === 'data' && item.dataUsageMode === 'validation-subject' && item.attachedSchema !== undefined)
        );
        return scoresComputed || hasMatched;
      case 'none':
        return false; // Manual advance only
      default:
        return false;
    }
  }, [waitCondition, isRunning, workspace.selectedId, workspace.items, domCheckTick]);

  // Navigate to required panel when step changes, and keep it selected
  // (but not if the step's condition is already met - let app's natural selection work)
  useEffect(() => {
    if (!activeTutorial || !isRunning || !navTarget) return;

    // Don't force navigation if current step's condition is already met
    // (step is about to advance, let the app's natural selection work)
    if (isConditionMet) return;

    // Resolve special navigation targets
    let targetId = navTarget;
    if (navTarget === FIRST_ITEM) {
      if (!firstItemId) return; // No items yet, wait
      targetId = firstItemId;
    } else if (navTarget === FIRST_MATCHED_ITEM) {
      if (!firstMatchedItemId) return; // No matched items yet, wait
      targetId = firstMatchedItemId;
    }

    // Re-select the target panel if something else gets selected
    if (workspace.selectedId !== targetId) {
      const timer = setTimeout(() => {
        workspace.selectItem(targetId);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [activeTutorial, stepIndex, isRunning, navTarget, workspace.selectedId, firstItemId, firstMatchedItemId, isConditionMet]);

  const stopTutorial = useCallback(() => {
    setActiveTutorial(null);
    setStepIndex(0);
    setIsRunning(false);
    setTutorialBranch(null); // Reset branch
  }, []);

  // Helper to check if a condition is met (for step skipping)
  const checkCondition = useCallback((condition: WaitCondition | undefined): boolean => {
    if (!condition) return false;
    switch (condition.type) {
      case 'hasMatchedData':
        return workspace.items.some(item =>
          (item.attachedData !== undefined) ||
          (item.source === 'data' && item.dataUsageMode === 'validation-subject' && item.attachedSchema !== undefined)
        );
      case 'elementNotExists':
        return document.querySelector(condition.selector) === null;
      case 'elementExists':
        return document.querySelector(condition.selector) !== null;
      case 'scoresComputedOrMatchedData':
        const scoresComputed = document.querySelector('[data-tutorial="scores-computed"]') !== null;
        const matched = workspace.items.some(item =>
          (item.attachedData !== undefined) ||
          (item.source === 'data' && item.dataUsageMode === 'validation-subject' && item.attachedSchema !== undefined)
        );
        return scoresComputed || matched;
      default:
        return false;
    }
  }, [workspace.items]);

  // Auto-advance when condition is met
  useEffect(() => {
    if (isConditionMet && activeTutorial && isRunning && steps.length > 0) {
      if (stepIndex < steps.length - 1) {
        // Small delay for smoother UX
        const timer = setTimeout(() => {
          // Find the next step that isn't already satisfied
          let nextIndex = stepIndex + 1;
          while (nextIndex < steps.length) {
            const nextStep = steps[nextIndex];
            const nextCondition = nextStep?.waitFor;
            // Skip steps whose conditions are already met (except 'none' which requires manual advance)
            if (nextCondition && nextCondition.type !== 'none' && checkCondition(nextCondition)) {
              nextIndex++;
            } else {
              break;
            }
          }

          if (nextIndex < steps.length) {
            setStepIndex(nextIndex);
          } else {
            stopTutorial();
          }
        }, 500);
        return () => clearTimeout(timer);
      } else {
        // Last step completed
        const timer = setTimeout(() => {
          stopTutorial();
        }, 500);
        return () => clearTimeout(timer);
      }
    }
  }, [isConditionMet, activeTutorial, stepIndex, isRunning, steps.length, steps, checkCondition, stopTutorial]);

  const startTutorial = useCallback((id: TutorialId) => {
    setActiveTutorial(id);
    setStepIndex(0);
    setIsRunning(true);
    setTutorialBranch(null); // Reset branch for fresh start
  }, []);

  const handleNext = useCallback(() => {
    if (!activeTutorial || steps.length === 0) return;
    if (stepIndex < steps.length - 1) {
      setStepIndex(prev => prev + 1);
    } else {
      stopTutorial();
    }
  }, [activeTutorial, stepIndex, stopTutorial, steps.length]);

  // Determine if we should show the Next button
  // - 'none' type: always show Next
  // - 'noneOrMatchedData': always show Next (can also auto-advance)
  // - 'noneOrElementExists': show Next only if element exists, otherwise wait
  const hasWaitCondition = useMemo(() => {
    if (!currentStep?.waitFor) return false;
    const type = currentStep.waitFor.type;
    if (type === 'none') return false;
    if (type === 'noneOrMatchedData') return false;
    if (type === 'noneOrElementExists') {
      // Show Next button only if element already exists
      const selector = (currentStep.waitFor as { selector: string }).selector;
      return document.querySelector(selector) === null;
    }
    return true;
  }, [currentStep?.waitFor, domCheckTick]);

  return (
    <TutorialContext.Provider value={{ activeTutorial, startTutorial, stopTutorial, isRunning }}>
      {children}
      {isRunning && currentStep && (
        <TutorialTooltip
          step={currentStep}
          stepIndex={stepIndex}
          totalSteps={totalSteps}
          onNext={handleNext}
          onSkip={stopTutorial}
          hasWaitCondition={!!hasWaitCondition}
        />
      )}
    </TutorialContext.Provider>
  );
};
