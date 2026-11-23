import { useState } from 'react';
import { connectSerialPrinter, getPrintMode, printLines, serialSupported, setPrintMode, type PrintMode } from '../lib/printer.ts';
import { Banner, Button, Field, Modal, Select } from '../ui/ui.tsx';

export function PrinterSettings({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<PrintMode>(getPrintMode());
  const [msg, setMsg] = useState<{ tone: 'error' | 'good' | 'warn'; text: string } | null>(null);

  return (
    <Modal title="Receipt printer and drawer" onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <Field label="Printing mode">
          <Select value={mode} onChange={(e) => { const m = e.target.value as PrintMode; setMode(m); setPrintMode(m); }}>
            <option value="escpos">ESC/POS over USB-serial (recommended: drawer opens only for cash)</option>
            <option value="browser">Browser print dialog (drawer cannot be controlled)</option>
          </Select>
        </Field>
        {mode === 'escpos' && !serialSupported() && <Banner tone="error">This browser has no Web Serial. Use Chrome or Edge on the till.</Banner>}
        {mode === 'browser' && (
          <Banner tone="warn">
            The browser cannot tell the drawer when to open. If the printer driver opens the drawer on every print,
            it will also open for M-Pesa and card sales. Use ESC/POS mode to meet the "drawer only for cash" rule.
          </Banner>
        )}
        <div className="flex flex-wrap gap-2">
          {mode === 'escpos' && (
            <Button onClick={async () => {
              try {
                await connectSerialPrinter();
                setMsg({ tone: 'good', text: 'Printer connected.' });
              } catch (e) {
                setMsg({ tone: 'error', text: (e as Error).message });
              }
            }}>Connect printer</Button>
          )}
          <Button onClick={async () => {
            const warn = await printLines(['TEST PRINT', new Date().toISOString(), 'If you can read this, printing works.'], false);
            setMsg(warn ? { tone: 'warn', text: warn } : { tone: 'good', text: 'Test page sent (drawer stays closed).' });
          }}>Test print</Button>
        </div>
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </div>
    </Modal>
  );
}
