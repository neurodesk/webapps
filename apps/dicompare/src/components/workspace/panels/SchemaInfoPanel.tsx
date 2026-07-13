import React, { useState, useEffect, useCallback, useRef } from 'react';
import MarkdownToolbar from '../../common/MarkdownToolbar';
import { markdownComponents } from '../../../utils/markdownRenderers';
import { handleMarkdownListContinuation } from '../../../utils/markdownEditor';
import { handleTableTab } from '../../../utils/tableEditor';
import { Loader, X, Book, Edit2, Eye, Download, Code, Check, AlertTriangle, Layers, UploadCloud, Copy, ExternalLink, Github, Globe, Quote, GitBranch } from 'lucide-react';
import { SchemaMetadata } from '../../../contexts/WorkspaceContext';
import { useWorkspace } from '../../../contexts/WorkspaceContext';
import { useSchemaContext } from '../../../contexts/SchemaContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { generateSchemaJson, downloadSchemaJson, copyToClipboard } from '../../../utils/schemaGeneration';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import WelcomeTab from './schemaInfo/WelcomeTab';

export type SchemaInfoTab = 'welcome' | 'metadata' | 'preview';

interface SchemaInfoPanelProps {
  schemaInfoTab: SchemaInfoTab;
  setSchemaInfoTab: (tab: SchemaInfoTab) => void;
  schemaMetadata: SchemaMetadata | null;
  getSchemaContent: (id: string) => Promise<string | null>;
  onUpdateSchemaMetadata: (updates: Partial<SchemaMetadata>) => void;
}

const SchemaInfoPanel: React.FC<SchemaInfoPanelProps> = ({
  schemaInfoTab,
  setSchemaInfoTab,
  schemaMetadata,
  getSchemaContent,
  onUpdateSchemaMetadata,
}) => {
  const workspace = useWorkspace();
  const { uploadSchema, schemas, updateExistingSchema } = useSchemaContext();
  const { theme } = useTheme();

  // Schema info editing state
  const [authorInput, setAuthorInput] = useState('');
  const [isEditingReadme, setIsEditingReadme] = useState(true);  // Default to edit tab
  const [editedReadme, setEditedReadme] = useState('');
  const [previewJson, setPreviewJson] = useState<string | null>(null);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  const [isSavingToLibrary, setIsSavingToLibrary] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  const [pendingSaveJson, setPendingSaveJson] = useState<string | null>(null);
  const [existingSchemaId, setExistingSchemaId] = useState<string | null>(null);
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishJson, setPublishJson] = useState<string | null>(null);
  const readmeTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Acquisition names in the workspace, for the "Link to acquisition" tool and
  // for resolving internal #acq links from the schema README.
  const workspaceAcquisitionNames = workspace.items
    .map(it => it.acquisition?.protocolName)
    .filter((n): n is string => !!n);
  const navigateToAcquisition = (name: string) => {
    const target = workspace.items.find(it => it.acquisition?.protocolName === name);
    if (target) workspace.selectItem(target.id);
  };

  // Sync editedReadme with schemaMetadata
  useEffect(() => {
    setEditedReadme(schemaMetadata?.description || '');
  }, [schemaMetadata?.description]);

  // Invalidate preview when workspace items change
  const itemsKey = workspace.items.map(i =>
    `${i.id}:${i.source}:${i.attachedSchema?.schemaId || ''}:${i.attachedSchema?.acquisitionId || ''}:${i.hasCreatedSchema || ''}`
  ).join(',');
  useEffect(() => {
    setPreviewJson(null);
  }, [itemsKey]);

  // Helper functions for author management
  const addAuthor = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !schemaMetadata?.authors?.includes(trimmed)) {
      const currentAuthors = schemaMetadata?.authors || [];
      onUpdateSchemaMetadata({ authors: [...currentAuthors, trimmed] });
    }
  };

  const removeAuthor = (authorToRemove: string) => {
    const currentAuthors = schemaMetadata?.authors || [];
    onUpdateSchemaMetadata({ authors: currentAuthors.filter(a => a !== authorToRemove) });
  };

  const handleAuthorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value.includes(',')) {
      const parts = value.split(',');
      parts.slice(0, -1).forEach(part => addAuthor(part));
      setAuthorInput(parts[parts.length - 1]);
    } else {
      setAuthorInput(value);
    }
  };

  const handleAuthorKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && authorInput.trim()) {
      e.preventDefault();
      addAuthor(authorInput);
      setAuthorInput('');
    } else if (e.key === 'Backspace' && !authorInput && schemaMetadata?.authors?.length) {
      const authors = schemaMetadata.authors;
      removeAuthor(authors[authors.length - 1]);
    }
  };

  // Generate preview JSON
  const generatePreview = useCallback(async () => {
    const currentDescription = editedReadme || schemaMetadata?.description || '';
    if (editedReadme && editedReadme !== schemaMetadata?.description) {
      onUpdateSchemaMetadata({ description: editedReadme });
    }

    setIsGeneratingPreview(true);
    try {
      const { acquisitions } = await workspace.getSchemaExport(getSchemaContent);
      const result = await generateSchemaJson({
        acquisitions,
        metadata: schemaMetadata || { name: '', description: '', authors: [], version: '1.0' },
        description: currentDescription,
      });
      setPreviewJson(result.json);
    } catch (err) {
      console.error('Failed to generate schema preview:', err);
    } finally {
      setIsGeneratingPreview(false);
    }
  }, [editedReadme, schemaMetadata, workspace, getSchemaContent, onUpdateSchemaMetadata]);

  // Auto-generate preview when on preview tab with no preview
  useEffect(() => {
    if (schemaInfoTab === 'preview' && !previewJson && !isGeneratingPreview) {
      generatePreview();
    }
  }, [schemaInfoTab, previewJson, isGeneratingPreview, generatePreview]);

  // Handle tab switch to preview
  const handlePreviewTabClick = () => {
    setSchemaInfoTab('preview');
    generatePreview();
  };

  // Download JSON
  const handleDownloadJson = async () => {
    let jsonToDownload = previewJson;

    if (!jsonToDownload) {
      const currentDescription = editedReadme || schemaMetadata?.description || '';
      if (editedReadme && editedReadme !== schemaMetadata?.description) {
        onUpdateSchemaMetadata({ description: editedReadme });
      }

      try {
        const { acquisitions } = await workspace.getSchemaExport(getSchemaContent);
        const result = await generateSchemaJson({
          acquisitions,
          metadata: schemaMetadata || { name: '', description: '', authors: [], version: '1.0' },
          description: currentDescription,
        });
        jsonToDownload = result.json;
        setPreviewJson(jsonToDownload);
      } catch (err) {
        console.error('Failed to generate schema:', err);
        return;
      }
    }

    downloadSchemaJson(
      jsonToDownload,
      schemaMetadata?.name || 'schema',
      schemaMetadata?.version || '1.0'
    );
  };

  // Copy JSON to clipboard
  const handleCopyJson = async () => {
    if (!previewJson) return;
    try {
      await copyToClipboard(previewJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Generate JSON for saving
  const generateJsonForSave = async (): Promise<string | null> => {
    if (previewJson) return previewJson;

    const currentDescription = editedReadme || schemaMetadata?.description || '';
    if (editedReadme && editedReadme !== schemaMetadata?.description) {
      onUpdateSchemaMetadata({ description: editedReadme });
    }

    try {
      const { acquisitions } = await workspace.getSchemaExport(getSchemaContent);
      const result = await generateSchemaJson({
        acquisitions,
        metadata: schemaMetadata || { name: '', description: '', authors: [], version: '1.0' },
        description: currentDescription,
      });
      setPreviewJson(result.json);
      return result.json;
    } catch (err) {
      console.error('Failed to generate schema:', err);
      return null;
    }
  };

  // Perform the actual save
  const performSave = async (jsonToSave: string, overwriteId?: string) => {
    setIsSavingToLibrary(true);
    setSaveMessage(null);
    try {
      const name = schemaMetadata?.name || 'schema';
      const version = schemaMetadata?.version || '1.0';

      if (overwriteId) {
        const schemaContent = JSON.parse(jsonToSave);
        await updateExistingSchema(overwriteId, schemaContent, {
          title: name,
          description: schemaMetadata?.description || '',
          authors: schemaMetadata?.authors || [],
          version: version,
        });
      } else {
        const blob = new Blob([jsonToSave], { type: 'application/json' });
        const fileName = `${name.replace(/\s+/g, '_')}_v${version}.json`;
        const file = new File([blob], fileName, { type: 'application/json' });

        await uploadSchema(file, {
          title: name,
          description: schemaMetadata?.description || '',
          authors: schemaMetadata?.authors || [],
          version: version,
        });
      }

      setSaveMessage({ type: 'success', text: `Schema "${name}" saved to library successfully!` });
      setTimeout(() => setSaveMessage(null), 5000);
    } catch (err) {
      console.error('Failed to save schema:', err);
      setSaveMessage({ type: 'error', text: 'Failed to save schema. Please try again.' });
    } finally {
      setIsSavingToLibrary(false);
      setShowOverwriteConfirm(false);
      setPendingSaveJson(null);
      setExistingSchemaId(null);
    }
  };

  // Check if metadata is valid for saving
  const isMetadataValid = schemaMetadata?.name?.trim() &&
    schemaMetadata?.authors?.length > 0 &&
    schemaMetadata?.version?.trim();

  // Save to library - checks for existing schema first
  const handleSaveToLibrary = async () => {
    // If metadata is invalid, show errors and navigate to the Save schema tab
    if (!isMetadataValid) {
      setShowValidationErrors(true);
      setSchemaInfoTab('metadata');
      return;
    }

    const jsonToSave = await generateJsonForSave();
    if (!jsonToSave) {
      setSaveMessage({ type: 'error', text: 'Failed to generate schema.' });
      return;
    }

    const schemaName = schemaMetadata?.name?.trim().toLowerCase();
    const existingSchema = schemas.find(s =>
      s.title?.trim().toLowerCase() === schemaName
    );

    if (existingSchema) {
      setPendingSaveJson(jsonToSave);
      setExistingSchemaId(existingSchema.id);
      setShowOverwriteConfirm(true);
    } else {
      await performSave(jsonToSave);
    }
  };

  // Handle overwrite confirmation
  const handleConfirmOverwrite = async () => {
    if (pendingSaveJson && existingSchemaId) {
      await performSave(pendingSaveJson, existingSchemaId);
    }
  };

  // Handle save as new
  const handleSaveAsNew = async () => {
    if (pendingSaveJson) {
      await performSave(pendingSaveJson);
    }
  };

  // Cancel overwrite dialog
  const handleCancelOverwrite = () => {
    setShowOverwriteConfirm(false);
    setPendingSaveJson(null);
    setExistingSchemaId(null);
  };

  // Publish to GitHub - validates, generates the JSON, then explains the next
  // steps in a modal before handing off to GitHub.
  const handlePublish = async () => {
    if (!isMetadataValid) {
      setShowValidationErrors(true);
      setSchemaInfoTab('metadata');
      return;
    }

    const jsonToPublish = await generateJsonForSave();
    if (!jsonToPublish) {
      setSaveMessage({ type: 'error', text: 'Failed to generate schema.' });
      return;
    }

    setPublishJson(jsonToPublish);
    setShowPublishModal(true);
  };

  // Continue from the publish modal: copy the schema (on this user gesture so
  // clipboard permission is granted) and open the pre-filled GitHub issue.
  const handleConfirmPublish = async () => {
    if (!publishJson) return;

    try {
      await copyToClipboard(publishJson);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
      setSaveMessage({ type: 'error', text: 'Failed to copy schema to clipboard.' });
    }

    const name = schemaMetadata?.name || 'Untitled';
    const version = schemaMetadata?.version || '1.0';
    const authors = schemaMetadata?.authors?.join(', ') || '';

    const title = `Schema submission: ${name}`;
    const body = [
      '## Schema Submission',
      '',
      `**Name:** ${name}`,
      `**Version:** ${version}`,
      `**Authors:** ${authors}`,
      '',
      '### Schema JSON',
      '',
      '> The schema JSON has been copied to your clipboard. Paste it below (replace this line):',
      '',
      '```json',
      '',
      '```',
      '',
      '---',
      '*Submitted via [dicompare](https://dicompare.neurodesk.org)*',
    ].join('\n');

    const url = `https://github.com/astewartau/dicompare-web/issues/new?` +
      `title=${encodeURIComponent(title)}` +
      `&body=${encodeURIComponent(body)}` +
      `&labels=${encodeURIComponent('schema-submission')}`;

    window.open(url, '_blank');
    setShowPublishModal(false);
  };

  return (
    <div className="border border-border rounded-lg bg-surface-primary shadow-sm flex flex-col h-full">
      {/* Tab bar */}
      <div className="px-6 pt-4 border-b border-border flex-shrink-0">
        <div className="flex gap-1">
          <button
            onClick={() => setSchemaInfoTab('welcome')}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              schemaInfoTab === 'welcome'
                ? 'bg-surface-primary text-brand-600 border border-b-0 border-border -mb-px'
                : 'text-content-tertiary hover:text-content-secondary'
            }`}
          >
            <Layers className="h-4 w-4 inline mr-1.5" />
            Welcome
          </button>
          <button
            onClick={() => setSchemaInfoTab('metadata')}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              schemaInfoTab === 'metadata'
                ? 'bg-surface-primary text-brand-600 border border-b-0 border-border -mb-px'
                : 'text-content-tertiary hover:text-content-secondary'
            }`}
          >
            <UploadCloud className="h-4 w-4 inline mr-1.5" />
            Save schema
          </button>
          <button
            onClick={handlePreviewTabClick}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              schemaInfoTab === 'preview'
                ? 'bg-surface-primary text-brand-600 border border-b-0 border-border -mb-px'
                : 'text-content-tertiary hover:text-content-secondary'
            }`}
          >
            <Code className="h-4 w-4 inline mr-1.5" />
            Preview JSON
          </button>
        </div>
      </div>

      {/* Action bar with buttons - only for Metadata and Preview tabs */}
      {schemaInfoTab !== 'welcome' && (
        <div className="px-6 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-content-tertiary uppercase tracking-wider">
              {schemaInfoTab === 'metadata' ? 'Save Schema' : 'JSON Preview'}
            </h3>
            <div className="flex items-center gap-2">
              {schemaInfoTab === 'preview' && (
                <button
                  onClick={handleCopyJson}
                  disabled={isGeneratingPreview || !previewJson}
                  className="flex items-center px-3 py-2 text-sm border border-border-secondary rounded-lg hover:bg-surface-secondary disabled:opacity-50 disabled:cursor-not-allowed text-content-secondary"
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4 mr-1.5" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-1.5" />
                      Copy
                    </>
                  )}
                </button>
              )}
              <button
                onClick={handleDownloadJson}
                disabled={isGeneratingPreview}
                className="flex items-center px-3 py-2 text-sm border border-border-secondary rounded-lg hover:bg-surface-secondary disabled:opacity-50 disabled:cursor-not-allowed text-content-secondary"
              >
                <Download className="h-4 w-4 mr-1.5" />
                Download JSON
              </button>
              <button
                onClick={handleSaveToLibrary}
                disabled={isGeneratingPreview || isSavingToLibrary}
                className="flex items-center px-3 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSavingToLibrary ? (
                  <>
                    <Loader className="h-4 w-4 mr-1.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <UploadCloud className="h-4 w-4 mr-1.5" />
                    Save to Library
                  </>
                )}
              </button>
              <button
                onClick={handlePublish}
                disabled={isGeneratingPreview || isSavingToLibrary}
                className="flex items-center px-3 py-2 text-sm font-medium text-white rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Submit this schema for inclusion in the public dicompare schema library"
              >
                <UploadCloud className="h-4 w-4 mr-1.5" />
                Publish to dicompare
                <ExternalLink className="h-3.5 w-3.5 ml-1.5 opacity-80" />
              </button>
            </div>
          </div>

          {/* Success/Error Message */}
          {saveMessage && (
            <div className={`mt-3 px-3 py-2 rounded-lg text-sm flex items-center ${
              saveMessage.type === 'success'
                ? 'bg-status-success-bg text-status-success border border-status-success/30'
                : 'bg-status-error-bg text-status-error border border-status-error/30'
            }`}>
              {saveMessage.type === 'success' ? (
                <Check className="h-4 w-4 mr-2 flex-shrink-0" />
              ) : (
                <X className="h-4 w-4 mr-2 flex-shrink-0" />
              )}
              {saveMessage.text}
              <button
                onClick={() => setSaveMessage(null)}
                className="ml-auto p-1 hover:bg-black/10 rounded"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Overwrite Confirmation Dialog */}
          {showOverwriteConfirm && (
            <div className="mt-3 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    Schema already exists
                  </p>
                  <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                    A schema named "{schemaMetadata?.name}" already exists in your library. What would you like to do?
                  </p>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={handleConfirmOverwrite}
                      disabled={isSavingToLibrary}
                      className="px-3 py-1.5 text-sm font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      {isSavingToLibrary ? 'Saving...' : 'Overwrite'}
                    </button>
                    <button
                      onClick={handleSaveAsNew}
                      disabled={isSavingToLibrary}
                      className="px-3 py-1.5 text-sm font-medium rounded-md border border-amber-600 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50"
                    >
                      Save as New
                    </button>
                    <button
                      onClick={handleCancelOverwrite}
                      disabled={isSavingToLibrary}
                      className="px-3 py-1.5 text-sm font-medium rounded-md text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Content */}
      {schemaInfoTab === 'welcome' ? (
        <WelcomeTab />
      ) : schemaInfoTab === 'metadata' ? (
      <div className="flex-1 overflow-y-auto p-6 min-h-0">
        {/* Explanatory info box */}
        <div className="mb-6 p-3 bg-surface-secondary border border-border rounded-lg text-sm text-content-secondary">
          Save your <strong className="text-content-primary">References</strong> as a reusable schema for validating future datasets.
          Only reference definitions are included — test data attachments are not saved.
        </div>

        {/* Basic Info Section */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          {/* Schema Name - Takes 2 columns */}
          <div className="lg:col-span-2">
            <label htmlFor="schema-name" className="block text-sm font-medium text-content-secondary mb-1.5">
              Schema Name <span className="text-status-error">*</span>
            </label>
            <input
              type="text"
              id="schema-name"
              value={schemaMetadata?.name || ''}
              onChange={(e) => {
                onUpdateSchemaMetadata({ name: e.target.value });
                if (e.target.value.trim()) setShowValidationErrors(false);
              }}
              className={`w-full px-3 py-2 border rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-sm ${
                showValidationErrors && !schemaMetadata?.name?.trim()
                  ? 'border-status-error'
                  : 'border-border'
              }`}
              placeholder="e.g., Brain MRI Protocol"
            />
            {showValidationErrors && !schemaMetadata?.name?.trim() && (
              <p className="mt-1 text-sm text-status-error">Schema name is required</p>
            )}
          </div>

          {/* Version - Takes 1 column */}
          <div>
            <label htmlFor="schema-version" className="block text-sm font-medium text-content-secondary mb-1.5">
              Version <span className="text-status-error">*</span>
            </label>
            <input
              type="text"
              id="schema-version"
              value={schemaMetadata?.version || ''}
              onChange={(e) => {
                onUpdateSchemaMetadata({ version: e.target.value });
                if (e.target.value.trim()) setShowValidationErrors(false);
              }}
              className={`w-full px-3 py-2 border rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-sm ${
                showValidationErrors && !schemaMetadata?.version?.trim()
                  ? 'border-status-error'
                  : 'border-border'
              }`}
              placeholder="1.0"
            />
            {showValidationErrors && !schemaMetadata?.version?.trim() && (
              <p className="mt-1 text-sm text-status-error">Version is required</p>
            )}
          </div>
        </div>

        {/* Authors Section */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-content-secondary mb-1.5">
            Authors <span className="text-status-error">*</span>
          </label>
          <div
            className={`flex flex-wrap items-center gap-1.5 px-2 py-1.5 border rounded-lg bg-surface-primary focus-within:ring-2 focus-within:ring-brand-500 focus-within:border-brand-500 min-h-[42px] cursor-text ${
              showValidationErrors && !schemaMetadata?.authors?.length
                ? 'border-status-error'
                : 'border-border'
            }`}
            onClick={(e) => {
              const input = e.currentTarget.querySelector('input');
              input?.focus();
            }}
          >
            {schemaMetadata?.authors?.map((author, index) => (
              <span
                key={index}
                className="inline-flex items-center pl-2.5 pr-1 py-0.5 rounded-md text-sm bg-surface-secondary border border-border text-content-primary"
              >
                {author}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAuthor(author);
                  }}
                  className="ml-1 p-0.5 rounded hover:bg-surface-tertiary text-content-tertiary hover:text-content-secondary"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input
              type="text"
              value={authorInput}
              onChange={handleAuthorInputChange}
              onKeyDown={handleAuthorKeyDown}
              onBlur={() => {
                if (authorInput.trim()) {
                  addAuthor(authorInput);
                  setAuthorInput('');
                  setShowValidationErrors(false);
                }
              }}
              className="flex-1 min-w-[120px] px-1 py-1 bg-transparent text-content-primary focus:outline-none"
              placeholder={schemaMetadata?.authors?.length ? '' : 'Type name, then comma or Enter...'}
            />
          </div>
          {showValidationErrors && !schemaMetadata?.authors?.length && (
            <p className="mt-1 text-sm text-status-error">At least one author is required</p>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-border my-6" />

        {/* README Section */}
        <div className="flex-1 flex flex-col">
          {/* Tab Header */}
          <div className="flex border-b border-border mb-0">
            <button
              onClick={() => setIsEditingReadme(true)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                isEditingReadme
                  ? 'border-brand-600 text-brand-600'
                  : 'border-transparent text-content-tertiary hover:text-content-secondary'
              }`}
            >
              <Edit2 className="h-3.5 w-3.5 inline mr-1.5" />
              Edit
            </button>
            <button
              onClick={() => {
                if (isEditingReadme && editedReadme !== (schemaMetadata?.description || '')) {
                  onUpdateSchemaMetadata({ description: editedReadme });
                }
                setIsEditingReadme(false);
              }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                !isEditingReadme
                  ? 'border-brand-600 text-brand-600'
                  : 'border-transparent text-content-tertiary hover:text-content-secondary'
              }`}
            >
              <Eye className="h-3.5 w-3.5 inline mr-1.5" />
              Preview
            </button>
          </div>

          {/* Tab Content */}
          {isEditingReadme ? (
            <>
            <MarkdownToolbar
              textareaRef={readmeTextareaRef}
              value={editedReadme}
              onChange={setEditedReadme}
              acquisitionNames={workspaceAcquisitionNames}
            />
            <textarea
              ref={readmeTextareaRef}
              value={editedReadme}
              onChange={(e) => setEditedReadme(e.target.value)}
              onKeyDown={(e) => {
                if (!handleTableTab(e, editedReadme, setEditedReadme)) {
                  handleMarkdownListContinuation(e, editedReadme, setEditedReadme);
                }
              }}
              className="flex-1 w-full min-h-[350px] p-4 border border-t-0 border-border rounded-b-lg font-mono text-sm bg-surface-secondary text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
              placeholder="# My Schema

Describe the purpose of this schema...

## Overview
What imaging protocol does this schema define?

## Acquisitions
- **T1w MPRAGE**: High-resolution structural imaging
- **T2w FLAIR**: White matter lesion detection

## Clinical Purpose
Explain the clinical use case.

## Notes
Any additional technical details or vendor-specific information."
            />
            </>
          ) : (
            <div className="flex-1 border border-t-0 border-border rounded-b-lg bg-surface-secondary min-h-[200px] overflow-auto">
              {schemaMetadata?.description ? (
                <div className="prose prose-sm max-w-none dark:prose-invert p-4">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => <h1 className="text-2xl font-bold text-content-primary mb-4 pb-2 border-b border-border">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-xl font-semibold text-content-primary mt-6 mb-3">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-lg font-semibold text-content-primary mt-4 mb-2">{children}</h3>,
                      h4: ({ children }) => <h4 className="text-base font-semibold text-content-primary mt-3 mb-2">{children}</h4>,
                      p: ({ children }) => <p className="text-content-secondary mb-3 leading-relaxed">{children}</p>,
                      ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1 text-content-secondary">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1 text-content-secondary">{children}</ol>,
                      li: ({ children }) => <li className="ml-2">{children}</li>,
                      strong: ({ children }) => <strong className="font-semibold text-content-primary">{children}</strong>,
                      code: ({ className, children, ...props }) => {
                        const isInline = !className;
                        if (isInline) {
                          return <code className="bg-surface-tertiary text-brand-600 dark:text-brand-400 px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>;
                        }
                        return (
                          <code className={`${className} block bg-gray-900 text-gray-100 p-4 rounded-lg text-sm font-mono overflow-x-auto`} {...props}>
                            {children}
                          </code>
                        );
                      },
                      pre: ({ children }) => <pre className="mb-4">{children}</pre>,
                      blockquote: ({ children }) => (
                        <blockquote className="border-l-4 border-brand-500 pl-4 py-1 my-3 text-content-secondary italic bg-surface-tertiary rounded-r">
                          {children}
                        </blockquote>
                      ),
                      a: markdownComponents(navigateToAcquisition).a,
                    }}
                  >
                    {schemaMetadata.description}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-content-tertiary">
                  <Book className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm mb-2">No documentation yet</p>
                  <button
                    onClick={() => setIsEditingReadme(true)}
                    className="text-sm text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
                  >
                    Add a README →
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      ) : (
      /* Preview JSON Tab */
      <div className="flex-1 overflow-y-auto p-6 min-h-0">
        {isGeneratingPreview || !previewJson ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader className="h-8 w-8 animate-spin text-brand-600 mx-auto mb-3" />
              <p className="text-content-secondary">Generating schema preview...</p>
            </div>
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden max-h-[calc(100vh-350px)]">
            <CodeMirror
              value={previewJson}
              extensions={[json()]}
              theme={theme === 'dark' ? 'dark' : 'light'}
              editable={false}
              height="100%"
              maxHeight="calc(100vh - 350px)"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: false,
              }}
            />
          </div>
        )}
      </div>
      )}

      {/* Publish-to-dicompare next-steps modal */}
      {showPublishModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowPublishModal(false)}
        >
          <div
            className="bg-surface-primary rounded-xl shadow-xl max-w-md w-full p-6 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 flex-shrink-0">
                <Github className="h-5 w-5 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-content-primary">Publish to dicompare</h3>
                <p className="text-sm text-content-secondary mt-1">
                  Contribute your schema to the public dicompare library so the community can find, reuse, and cite your protocol.
                </p>
              </div>
              <button
                onClick={() => setShowPublishModal(false)}
                className="p-1 rounded text-content-tertiary hover:text-content-primary hover:bg-surface-secondary flex-shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* What publishing gives you */}
            <div className="mt-4 rounded-lg border border-indigo-200/60 dark:border-indigo-800/50 bg-indigo-50/50 dark:bg-indigo-900/10 p-3 space-y-2.5">
              <div className="flex items-start gap-2.5">
                <Globe className="h-4 w-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-content-secondary">
                  <strong className="text-content-primary">Discoverable.</strong> It joins the public schema library, searchable and usable by anyone validating against your protocol.
                </p>
              </div>
              <div className="flex items-start gap-2.5">
                <Quote className="h-4 w-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-content-secondary">
                  <strong className="text-content-primary">Citable.</strong> It's archived on Zenodo with a permanent <strong className="text-content-primary">DOI</strong>, so others can cite your protocol in papers.
                </p>
              </div>
              <div className="flex items-start gap-2.5">
                <GitBranch className="h-4 w-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-content-secondary">
                  <strong className="text-content-primary">Versioned.</strong> Updates get a new version under one stable concept DOI, so links to your work never break.
                </p>
              </div>
            </div>

            <p className="text-xs font-medium text-content-tertiary uppercase tracking-wider mt-4 mb-1">How it works</p>
            <ol className="space-y-2.5">
              {[
                <>The schema JSON is <strong className="text-content-primary">copied to your clipboard</strong>.</>,
                <>A pre-filled GitHub issue opens in a <strong className="text-content-primary">new tab</strong>.</>,
                <>Log in to GitHub if you aren't already.</>,
                <>Paste (<span className="font-mono text-xs">Ctrl/Cmd + V</span>) the schema into the <span className="font-mono text-xs">```json</span> code block.</>,
                <>Click <strong className="text-content-primary">Submit new issue</strong> — that's it!</>,
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 text-xs font-semibold flex items-center justify-center mt-0.5">
                    {i + 1}
                  </span>
                  <span className="text-sm text-content-secondary">{step}</span>
                </li>
              ))}
            </ol>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setShowPublishModal(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-border-secondary text-content-secondary hover:bg-surface-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmPublish}
                className="flex items-center px-4 py-2 text-sm font-medium text-white rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-sm transition-colors"
              >
                Continue to GitHub
                <ExternalLink className="h-3.5 w-3.5 ml-1.5 opacity-80" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SchemaInfoPanel;
