import { useEffect, useRef } from 'react';
import { createConsole } from '@neurodesk/webapp-components/ui';
import { clearLog, useTechnicalLog } from '../utils/technicalLog';

/**
 * Collapsed technical log below the workspace. The shared createConsole()
 * element owns the disclosure, Copy and Clear actions and the 120 px
 * monospace output; this component feeds it from the technicalLog store and
 * the element opens itself when an error is logged.
 */
export default function TechnicalLog() {
  const host = useRef<HTMLDivElement>(null);
  const element = useRef<ReturnType<typeof createConsole> | null>(null);
  const lastId = useRef(0);
  const entries = useTechnicalLog();

  useEffect(() => {
    const log = createConsole({ id: 'technicalLog', title: 'Technical log' });
    element.current = log;
    host.current?.append(log);
    const clear = log.querySelector('#technicalLogClear');
    const onClear = () => clearLog();
    clear?.addEventListener('click', onClear);
    return () => {
      clear?.removeEventListener('click', onClear);
      log.remove();
      element.current = null;
      lastId.current = 0;
    };
  }, []);

  useEffect(() => {
    const log = element.current;
    if (!log) return;
    for (const entry of entries) {
      if (entry.id <= lastId.current) continue;
      log.log(entry.message, entry.level);
      lastId.current = entry.id;
    }
  }, [entries]);

  return <div ref={host} className="dicompare-technical-log" />;
}
