/**
 * Guided Tutorial
 *
 * A dependency-free coach-mark tour. Each step points at an existing element in
 * the app; the engine draws a spotlight around it and anchors a tooltip nearby.
 * Steps advance manually (Next/Back) or automatically when a `waitFor`
 * predicate becomes true, giving a "walk you through it as you do it" feel.
 *
 * Step shape:
 *   {
 *     selector: string,          // CSS selector for the target element
 *     title: string,
 *     body: string,
 *     placement?: 'right'|'left'|'top'|'bottom',   // default 'right'
 *     onEnter?: () => void,      // e.g. expand an accordion section
 *     waitFor?: () => boolean    // auto-advance when this returns true
 *   }
 */

const POLL_MS = 200;
const PADDING = 12;      // gap between spotlight and tooltip
const VIEWPORT_PAD = 16; // keep tooltip this far from the viewport edge

export class Tutorial {
  /**
   * @param {Array} steps
   */
  constructor(steps = []) {
    this.steps = steps;
    this.index = 0;
    this.active = false;

    this.spotlight = null;
    this.tooltip = null;
    this._pollId = null;
    this._boundReposition = () => this._reposition();
  }

  isRunning() {
    return this.active;
  }

  start() {
    if (this.active || this.steps.length === 0) return;
    this.active = true;
    this.index = 0;
    this._buildDom();
    window.addEventListener('resize', this._boundReposition);
    window.addEventListener('scroll', this._boundReposition, true);
    this._pollId = setInterval(() => this._tick(), POLL_MS);
    this._render();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this._pollId);
    this._pollId = null;
    window.removeEventListener('resize', this._boundReposition);
    window.removeEventListener('scroll', this._boundReposition, true);
    this.spotlight?.remove();
    this.tooltip?.remove();
    this.spotlight = null;
    this.tooltip = null;
  }

  next() {
    if (this.index >= this.steps.length - 1) {
      this.stop();
    } else {
      this.index += 1;
      this._render();
    }
  }

  back() {
    if (this.index > 0) {
      this.index -= 1;
      this._render();
    }
  }

  // --- internals ---------------------------------------------------------

  _buildDom() {
    this.spotlight = document.createElement('div');
    this.spotlight.className = 'tour-spotlight';

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tour-tooltip';

    document.body.append(this.spotlight, this.tooltip);
  }

  _currentTarget() {
    const step = this.steps[this.index];
    return step ? document.querySelector(step.selector) : null;
  }

  _render() {
    const step = this.steps[this.index];
    if (!step) {
      this.stop();
      return;
    }

    // Run side effects (expand a section, scroll into view, etc.)
    try {
      step.onEnter?.();
    } catch {
      /* non-fatal */
    }

    const isLast = this.index === this.steps.length - 1;
    const hasBack = this.index > 0;

    this.tooltip.innerHTML = `
      <h4></h4>
      <p></p>
      <div class="tour-tooltip-footer">
        <div>
          <span class="tour-step-count">${this.index + 1} / ${this.steps.length}</span>
        </div>
        <div class="tour-tooltip-buttons">
          <button class="tour-skip" type="button">Skip</button>
          ${hasBack ? '<button class="tour-btn tour-btn-ghost" data-act="back" type="button">Back</button>' : ''}
          <button class="tour-btn tour-btn-primary" data-act="next" type="button">${isLast ? 'Finish' : 'Next'}</button>
        </div>
      </div>
    `;
    // Assign text content safely (avoid HTML injection from step strings).
    this.tooltip.querySelector('h4').textContent = step.title;
    this.tooltip.querySelector('p').textContent = step.body;

    this.tooltip.querySelector('.tour-skip').addEventListener('click', () => this.stop());
    this.tooltip.querySelector('[data-act="next"]').addEventListener('click', () => this.next());
    this.tooltip.querySelector('[data-act="back"]')?.addEventListener('click', () => this.back());

    // Bring the target into view, then position.
    const target = this._currentTarget();
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this._reposition();
  }

  _tick() {
    // Auto-advance when the step's condition is satisfied.
    const step = this.steps[this.index];
    if (step?.waitFor) {
      let met = false;
      try {
        met = !!step.waitFor();
      } catch {
        met = false;
      }
      if (met) {
        this.next();
        return;
      }
    }
    this._reposition();
  }

  _reposition() {
    if (!this.active || !this.tooltip) return;
    const step = this.steps[this.index];
    const target = this._currentTarget();

    if (!target) {
      // Target missing — hide spotlight, center the tooltip.
      if (this.spotlight) this.spotlight.style.display = 'none';
      this.tooltip.style.top = '50%';
      this.tooltip.style.left = '50%';
      this.tooltip.style.transform = 'translate(-50%, -50%)';
      return;
    }

    this.tooltip.style.transform = 'none';
    const rect = target.getBoundingClientRect();

    // Spotlight over the target.
    if (this.spotlight) {
      this.spotlight.style.display = 'block';
      this.spotlight.style.top = `${rect.top - 4}px`;
      this.spotlight.style.left = `${rect.left - 4}px`;
      this.spotlight.style.width = `${rect.width + 8}px`;
      this.spotlight.style.height = `${rect.height + 8}px`;
    }

    // Tooltip placement.
    const tt = this.tooltip.getBoundingClientRect();
    const placement = step.placement || 'right';
    let top;
    let left;

    switch (placement) {
      case 'left':
        top = rect.top + rect.height / 2 - tt.height / 2;
        left = rect.left - tt.width - PADDING;
        break;
      case 'top':
        top = rect.top - tt.height - PADDING;
        left = rect.left + rect.width / 2 - tt.width / 2;
        break;
      case 'bottom':
        top = rect.bottom + PADDING;
        left = rect.left + rect.width / 2 - tt.width / 2;
        break;
      case 'right':
      default:
        top = rect.top + rect.height / 2 - tt.height / 2;
        left = rect.right + PADDING;
        break;
    }

    // If a side placement overflows horizontally, flip to the other side.
    if (left + tt.width > window.innerWidth - VIEWPORT_PAD && placement === 'right') {
      left = rect.left - tt.width - PADDING;
    } else if (left < VIEWPORT_PAD && placement === 'left') {
      left = rect.right + PADDING;
    }

    // Clamp to viewport.
    left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - tt.width - VIEWPORT_PAD));
    top = Math.max(VIEWPORT_PAD, Math.min(top, window.innerHeight - tt.height - VIEWPORT_PAD));

    this.tooltip.style.top = `${top}px`;
    this.tooltip.style.left = `${left}px`;
  }
}

/**
 * Welcome-tour prompt shown once after the user first launches the app.
 * Offers to start the tour, with a "Don't show again" opt-out.
 */
const DISMISS_KEY = 'qsmbly_tutorial_dismissed';

export class WelcomePrompt {
  /**
   * @param {Object} opts
   * @param {() => void} opts.onStart  Called when the user starts the tour.
   */
  constructor({ onStart } = {}) {
    this.onStart = onStart;
    this.modal = document.getElementById('welcomeModal');
    this._wire();
  }

  isDismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === 'true';
    } catch {
      return false;
    }
  }

  open() {
    this.modal?.classList.add('active');
  }

  close() {
    this.modal?.classList.remove('active');
    const checkbox = document.getElementById('welcomeDontShow');
    if (checkbox?.checked) {
      try {
        localStorage.setItem(DISMISS_KEY, 'true');
      } catch {
        /* non-fatal */
      }
    }
  }

  _wire() {
    if (!this.modal) return;

    document.getElementById('welcomeStartTour')?.addEventListener('click', () => {
      this.close();
      this.onStart?.();
    });
    document.getElementById('welcomeLater')?.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  }
}
