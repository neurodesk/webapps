import { useEffect, useRef } from 'react';
import { renderExampleSelector, renderSidebarSection } from '@neurodesk/webapp-components/ui';
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import examples from '../../../examples.json';
import { useWorkspace } from '../../contexts/WorkspaceContext';

export default function ExampleInput() {
  const host = useRef<HTMLDivElement>(null);
  const { addFromData, attachData, createSchemaForItem, toggleEditing, isProcessing } = useWorkspace();
  const actions = useRef({ addFromData, attachData, createSchemaForItem, toggleEditing });
  actions.current = { addFromData, attachData, createSchemaForItem, toggleEditing };
  const selector = useRef<ReturnType<typeof renderExampleSelector> | null>(null);

  useEffect(() => {
    const control = renderExampleSelector({
      examples,
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
    const section = renderSidebarSection({ title: 'Example input', content: control.root });
    host.current?.append(section.root);
    return () => {
      control.destroy();
      section.root.remove();
      selector.current = null;
    };
  }, []);

  useEffect(() => selector.current?.setDisabled(isProcessing), [isProcessing]);

  return <div ref={host} className="nd-imaging-controls" />;
}
