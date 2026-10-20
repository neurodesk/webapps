import { useEffect, useRef } from 'react';
import { createExampleSelector, renderSidebarSection } from '@neurodesk/webapp-components/ui';
import { handoffId, takeHandoff } from '@neurodesk/webapp-components/handoff';
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import examples from '../../../examples.json';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { log } from '../../utils/technicalLog';

// Claimed once per page, whatever React does with effects.
let handoffOpened = handoffId(location.hash) ? takeHandoff() : null;

export default function ExampleInput() {
  const host = useRef<HTMLDivElement>(null);
  const { addFromData, attachData, createSchemaForItem, toggleEditing, isProcessing } = useWorkspace();
  const actions = useRef({ addFromData, attachData, createSchemaForItem, toggleEditing });
  actions.current = { addFromData, attachData, createSchemaForItem, toggleEditing };
  const selector = useRef<ReturnType<typeof createExampleSelector> | null>(null);

  useEffect(() => {
    const control = createExampleSelector({
      scope: host.current?.parentElement ?? undefined,
      examples,
      onStatus(text: string, error?: boolean) {
        if (text) log(text, error ? 'error' : 'info');
      },
      async onLoad(example, { fetchFiles, assertCurrent }) {
        const files = await fetchFiles();
        assertCurrent();
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        const ids = await actions.current.addFromData(transfer.files, 'schema-template', assertCurrent);
        assertCurrent();
        const id = ids?.[0];
        if (!id) throw new Error('The example did not create a reference acquisition.');
        actions.current.createSchemaForItem(id);
        actions.current.toggleEditing(id);
        await actions.current.attachData(id, transfer.files, assertCurrent);
      },
    });
    selector.current = control;
    const section = renderSidebarSection({ title: 'Example input', content: control });
    host.current?.append(section.root);
    return () => {
      control.destroy();
      section.root.remove();
      selector.current = null;
    };
  }, []);

  useEffect(() => selector.current?.setDisabled(isProcessing), [isProcessing]);

  // DICOM files another app sent here (index.html marks this page as their receiver) open
  // as reference acquisitions, as files chosen under From data would.
  useEffect(() => {
    if (!handoffOpened) return;
    const received = handoffOpened;
    handoffOpened = null;
    void received.then(async (handoff) => {
      if (!handoff) return;
      const transfer = new DataTransfer();
      for (const file of handoff.files) transfer.items.add(file);
      log(`Opening ${handoff.files.length} DICOM file${handoff.files.length === 1 ? '' : 's'} from ${handoff.source.title}`);
      await actions.current.addFromData(transfer.files, 'schema-template');
    }).catch((error: unknown) => log(error instanceof Error ? error.message : String(error), 'error'));
  }, []);

  return <div ref={host} className="nd-imaging-controls" />;
}
