let ctx: AudioContext | null = null;

function tone(freq: number, ms: number, type: OscillatorType = 'square') {
  try {
    ctx ??= new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  } catch {
    /* audio is best-effort */
  }
}

/** Short high beep: item added. */
export const beepOk = () => tone(1600, 60, 'sine');
/** Low double buzz: unknown barcode or an error (FR-CO-1). */
export function beepError() {
  tone(220, 180);
  setTimeout(() => tone(180, 220), 220);
}
