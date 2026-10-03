// Two-finger touch gestures for the embedded viewer.
//
// NiiVue 1.0.0-rc.13 tracks a single pointer: a second finger only moves the
// crosshair, so a phone or tablet can neither zoom nor pan. This adapter turns
// a two-finger gesture into the zoom and pan NiiVue already implements:
//
//   - pinch on a slice    -> `pan2Dxyzmm[3]` (the 2D zoom factor)
//   - pinch on the render -> `scaleMultiplier` (the 3D zoom factor)
//   - two-finger drag on a slice -> a pan drag, replayed to NiiVue as one
//     synthetic pointer at the midpoint, so NiiVue's own pixel-to-millimetre
//     mapping is used
//
// Only public properties and DOM pointer events are used. One-finger touches
// and every mouse or pen event pass through untouched. Remove this file once
// NiiVue handles multi-touch itself.

const ZOOM_2D = [0.1, 10];
const ZOOM_3D = [0.5, 2];
const clamp = (value, [low, high]) => Math.max(low, Math.min(high, value));

/**
 * @param nv NiiVue instance attached to `canvas`.
 * @param canvas The viewer canvas.
 * @param constants `{ dragModePan, sliceTypeRender }` from the NiiVue build in use.
 * @param createEvent Builds the synthetic pointer event (injectable for tests).
 * @returns A function that removes the listeners.
 */
export function bindTouchGestures(nv, canvas, { dragModePan, sliceTypeRender }, createEvent = (type, init) => new PointerEvent(type, init)) {
  const touches = new Map();
  const synthetic = new WeakSet();
  let gesture = null;
  // After a gesture ends, the fingers still down must not move the crosshair.
  let swallowing = false;

  const send = (type, pointerId, [clientX, clientY]) => {
    const event = createEvent(type, {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    });
    synthetic.add(event);
    canvas.dispatchEvent(event);
  };

  const measure = () => {
    const [a, b] = gesture.ids.map((id) => touches.get(id));
    return {
      distance: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
      middle: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    };
  };

  const begin = (first, second) => {
    // NiiVue saw the first finger go down; end that drag before taking over.
    send('pointerup', first, touches.get(first));
    const isRender = nv.activeTileHit?.isRender ?? nv.sliceType === sliceTypeRender;
    gesture = { ids: [first, second], isRender, pans: !isRender && !nv.drawIsEnabled };
    const { distance, middle } = measure();
    gesture.distance = distance;
    gesture.zoom = isRender ? nv.scaleMultiplier : nv.pan2Dxyzmm[3];
    if (gesture.pans) {
      gesture.primaryDragMode = nv.primaryDragMode;
      nv.primaryDragMode = dragModePan;
      send('pointerdown', first, middle);
    }
  };

  const update = () => {
    const { distance, middle } = measure();
    const zoom = gesture.zoom * (distance / gesture.distance);
    if (gesture.isRender) {
      nv.scaleMultiplier = clamp(zoom, ZOOM_3D);
      return;
    }
    if (gesture.pans) send('pointermove', gesture.ids[0], middle);
    const pan = nv.pan2Dxyzmm;
    nv.pan2Dxyzmm = [pan[0], pan[1], pan[2], clamp(zoom, ZOOM_2D)];
  };

  const end = (liftedId) => {
    if (gesture.pans) {
      // Release through the finger that is still down: its pointer is active.
      const remaining = gesture.ids.find((id) => id !== liftedId);
      send('pointerup', remaining, measure().middle);
      nv.primaryDragMode = gesture.primaryDragMode;
    }
    gesture = null;
    swallowing = true;
  };

  const onDown = (event) => {
    if (synthetic.has(event) || event.pointerType !== 'touch') return;
    touches.set(event.pointerId, [event.clientX, event.clientY]);
    if (touches.size < 2) {
      swallowing = false;
      return;
    }
    event.stopImmediatePropagation();
    if (touches.size === 2 && !gesture) {
      const [first, second] = touches.keys();
      begin(first, second);
    }
  };

  const onMove = (event) => {
    if (synthetic.has(event) || event.pointerType !== 'touch' || !touches.has(event.pointerId)) return;
    touches.set(event.pointerId, [event.clientX, event.clientY]);
    if (!gesture && !swallowing) return;
    event.stopImmediatePropagation();
    if (gesture?.ids.includes(event.pointerId)) update();
  };

  const onUp = (event) => {
    if (synthetic.has(event) || event.pointerType !== 'touch' || !touches.has(event.pointerId)) return;
    if (gesture || swallowing) event.stopImmediatePropagation();
    if (gesture?.ids.includes(event.pointerId)) end(event.pointerId);
    touches.delete(event.pointerId);
    if (touches.size === 0) swallowing = false;
  };

  // Capture listeners on the target run before NiiVue's own listeners.
  const listeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp]];
  for (const [type, listener] of listeners) canvas.addEventListener(type, listener, { capture: true });
  return () => {
    for (const [type, listener] of listeners) canvas.removeEventListener(type, listener, { capture: true });
  };
}
