// Receipts and the cash drawer.
//
// Two modes, chosen per till in the Printer settings dialog:
//  * "browser": the receipt is printed through the browser print dialog (use
//    Chrome's --kiosk-printing flag to print silently). The browser cannot send
//    a drawer-kick command, so if the printer driver is set to "open drawer on
//    print" the drawer opens for EVERY receipt, which breaks FR-CO-7.
//  * "escpos": the app talks ESC/POS to the receipt printer over Web Serial
//    (Chrome/Edge; printer must expose a serial/COM port) and sends the
//    drawer-kick pulse ONLY for cash sales, change due and approved no-sales.
//    This is the recommended mode.
import { formatAmount, REASON_LABELS, type Receipt } from '@shop/shared';

export type PrintMode = 'browser' | 'escpos';
const MODE_KEY = 'pos.printer.mode';
const WIDTH = 42; // characters per line on 80 mm paper (Font A)

export function getPrintMode(): PrintMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'escpos' ? 'escpos' : 'browser';
  } catch {
    return 'browser';
  }
}
export function setPrintMode(mode: PrintMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

// ---- Web Serial (minimal typings; not in the TS DOM lib) --------------------
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
  readable: unknown;
}
interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}
const serial = (): SerialLike | undefined => (navigator as unknown as { serial?: SerialLike }).serial;
let port: SerialPortLike | null = null;

export const serialSupported = () => serial() !== undefined;

/** Must be called from a click (browser rule). Remembers the port for later. */
export async function connectSerialPrinter(): Promise<void> {
  const s = serial();
  if (!s) throw new Error('This browser has no Web Serial support. Use Chrome or Edge.');
  const p = await s.requestPort();
  await p.open({ baudRate: 9600 });
  port = p;
}

async function getPort(): Promise<SerialPortLike> {
  if (port?.writable) return port;
  const s = serial();
  if (!s) throw new Error('Web Serial is not available');
  const [p] = await s.getPorts();
  if (!p) throw new Error('No receipt printer connected. Open Printer settings and connect it.');
  if (!p.writable) await p.open({ baudRate: 9600 });
  port = p;
  return p;
}

async function writeBytes(bytes: Uint8Array) {
  const p = await getPort();
  const writer = p.writable!.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

const ESC = 0x1b;
const GS = 0x1d;
const DRAWER_KICK = [ESC, 0x70, 0x00, 0x19, 0xfa];

function ascii(s: string): number[] {
  return Array.from(s.normalize('NFKD').replace(/[^\x20-\x7e\n]/g, '')).map((c) => c.charCodeAt(0));
}

// ---- Receipt text (shared by both modes) ------------------------------------
const pad = (l: string, r: string, w = WIDTH) => l + ' '.repeat(Math.max(1, w - l.length - r.length)) + r;
const center = (s: string, w = WIDTH) => ' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s;
const rule = () => '-'.repeat(WIDTH);
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
const methodLabel = (m: string) => (m === 'MPESA' ? 'M-Pesa' : m === 'CARD' ? 'Card' : 'Cash');

export function receiptLines(r: Receipt, refundDays: number): string[] {
  const out = [center(r.storeName), center(`Receipt ${r.receiptLabel}`), center(when(r.createdAt)), center(`Served by ${r.cashierName}`)];
  if (r.reprint) out.push(center('*** REPRINT ***'));
  out.push(rule());
  for (const l of r.lines) {
    out.push(l.name.slice(0, WIDTH));
    out.push(pad(`  ${l.qty} x ${formatAmount(l.unitPriceCents)}${l.overridden ? ' *' : ''}`, formatAmount(l.lineTotalCents)));
  }
  out.push(rule());
  if (r.listTotalCents !== r.totalCents) out.push(pad('Discount', formatAmount(r.totalCents - r.listTotalCents)));
  out.push(pad('TOTAL KES', formatAmount(r.totalCents)));
  for (const p of r.payments) {
    if (p.method === 'CASH') {
      out.push(pad('Cash tendered', formatAmount(p.tenderedCents ?? p.amountCents)));
    } else {
      out.push(pad(`${methodLabel(p.method)} ${p.mpesaCode ?? p.cardRef ?? ''}`.trim(), formatAmount(p.amountCents)));
    }
  }
  if (r.changeDueCents > 0) out.push(pad('CHANGE', formatAmount(r.changeDueCents)));
  out.push(rule(), center(`Items: ${r.itemCount}`));
  if (refundDays > 0) out.push(center(`Returns within ${refundDays} days with this receipt`));
  out.push(center('Thank you'));
  return out;
}

export interface SlipInput {
  title: string;
  storeName: string;
  cashierName: string;
  createdAt: string;
  rows: [string, string][];
  footer?: string;
}

export function slipLines(s: SlipInput): string[] {
  return [
    center(s.storeName), center(s.title), center(when(s.createdAt)), center(`By ${s.cashierName}`), rule(),
    ...s.rows.map(([l, r]) => pad(l, r)), rule(), ...(s.footer ? [center(s.footer)] : []),
  ];
}

// ---- Output -----------------------------------------------------------------
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function printViaBrowser(lines: string[]) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 80mm auto; margin: 3mm; }
    body { margin: 0; font: 12px/1.35 ui-monospace, "Courier New", monospace; color: #000; background: #fff; }
    pre { margin: 0; white-space: pre-wrap; }
  </style></head><body><pre>${escapeHtml(lines.join('\n'))}</pre></body></html>`;
  // The scanner types into whatever has focus, so printing must never leave
  // focus inside the receipt frame: remember it and give it straight back.
  const previous = document.activeElement as HTMLElement | null;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = html;
  frame.onload = () => {
    try {
      frame.contentWindow?.print();
    } finally {
      window.focus();
      previous?.focus?.();
      setTimeout(() => frame.remove(), 60_000);
    }
  };
  document.body.appendChild(frame);
}

async function printViaEscpos(lines: string[], openDrawer: boolean) {
  const bytes: number[] = [ESC, 0x40]; // initialise
  if (openDrawer) bytes.push(...DRAWER_KICK);
  for (const line of lines) bytes.push(...ascii(line), 0x0a);
  bytes.push(0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00); // feed + partial cut
  await writeBytes(new Uint8Array(bytes));
}

/**
 * Print lines and, in ESC/POS mode, open the drawer only when asked.
 * Returns a warning string if something could not be done (never throws), so
 * a completed sale is never reported as failed because of the printer.
 */
export async function printLines(lines: string[], openDrawer: boolean): Promise<string | null> {
  try {
    if (getPrintMode() === 'escpos') {
      await printViaEscpos(lines, openDrawer);
    } else {
      printViaBrowser(lines);
    }
    return null;
  } catch (e) {
    printViaBrowser(lines);
    return `Receipt printer: ${(e as Error).message}. Printed through the browser instead${openDrawer ? '; open the drawer with the key' : ''}.`;
  }
}

export const printReceipt = (r: Receipt, refundDays: number) => printLines(receiptLines(r, refundDays), r.openDrawer);

export const reasonLabel = (code: string) => REASON_LABELS[code] ?? code;
