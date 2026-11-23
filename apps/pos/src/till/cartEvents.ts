import type { RouteInput } from '@shop/shared';
import { ApiError, post } from '../lib/api.ts';

type CartEvent = RouteInput<'cart-events'>;

// FR-CO-8: removed lines and cancelled carts are logged even though no sale
// happened. Events are queued and retried with the same eventKey, so a flaky
// connection never loses one and never logs one twice.
const queue: CartEvent[] = [];
let flushing = false;

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      try {
        await post('cart-events', queue[0]!);
        queue.shift();
      } catch (e) {
        // Business rejections (e.g. the shift closed) will never succeed: drop them.
        if (e instanceof ApiError && e.code !== 'NETWORK' && e.code !== 'UPSTREAM_ERROR' && e.code !== 'RATE_LIMITED' && e.code !== 'NOT_AUTHENTICATED') {
          console.error('cart event rejected', e.code, queue.shift());
          continue;
        }
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

setInterval(() => void flush(), 15_000);

export function logCartEvent(event: CartEvent) {
  queue.push(event);
  void flush();
}

export const pendingCartEvents = () => queue.length;
