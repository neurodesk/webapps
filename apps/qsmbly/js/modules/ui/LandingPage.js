/**
 * Landing Page Controller
 *
 * Manages the full-viewport welcome overlay (#landingPage) shown on top of the
 * app. On first visit the overlay is visible; once the user launches the app it
 * is hidden and a flag is stored so returning visitors go straight to the tool.
 *
 * The overlay is hidden by toggling `landing-seen` on <html> (CSS handles the
 * actual display), which matches the FOUC-avoiding head script in index.html.
 */

const STORAGE_KEY = 'qsmbly_seen_landing';

export class LandingPage {
  /**
   * @param {Object} opts
   * @param {() => void} [opts.onLaunch]      Called when launching normally.
   * @param {() => void} [opts.onLaunchTour]  Called when launching with the tour.
   */
  constructor({ onLaunch, onLaunchTour } = {}) {
    this.onLaunch = onLaunch;
    this.onLaunchTour = onLaunchTour;
    this.overlay = document.getElementById('landingPage');

    this._wire();
  }

  /** True the first time this browser opens the app (nothing stored yet). */
  isFirstVisit() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'true';
    } catch {
      return true;
    }
  }

  /** Show the landing overlay (e.g. when the logo is clicked). */
  show() {
    document.documentElement.classList.remove('landing-seen');
    if (this.overlay) this.overlay.scrollTop = 0;
  }

  /** Hide the overlay and remember that the user has seen it. */
  hide() {
    document.documentElement.classList.add('landing-seen');
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      /* storage may be unavailable (private mode); non-fatal */
    }
  }

  _wire() {
    if (!this.overlay) return;

    const launchBtn = document.getElementById('landingLaunch');
    const tourBtn = document.getElementById('landingLaunchTour');
    const navLaunch = document.getElementById('landingNavLaunch');

    const launch = () => {
      this.hide();
      this.onLaunch?.();
    };

    launchBtn?.addEventListener('click', launch);
    navLaunch?.addEventListener('click', (e) => {
      e.preventDefault();
      launch();
    });

    tourBtn?.addEventListener('click', () => {
      this.hide();
      this.onLaunchTour?.();
    });
  }
}
