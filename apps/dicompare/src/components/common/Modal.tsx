import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Shared modal primitive.
 *
 * Handles the concerns every dialog needs but few implemented consistently:
 * a portal, backdrop, scroll lock, Escape-to-close, click-outside-to-close,
 * a focus trap, focus restoration on close, and the `role="dialog"` /
 * `aria-modal` wiring. Callers supply only content (and optionally a header via
 * `title`); everything below `size` is styling/behaviour opt-outs.
 */

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'full';

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-5xl',
  '3xl': 'max-w-6xl',
  full: 'max-w-none',
};

// Elements that can receive keyboard focus, for the focus trap.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalProps {
  /** Whether the modal is rendered. */
  isOpen: boolean;
  /** Called on Escape, backdrop click, or close-button click. */
  onClose: () => void;
  /** Optional header title. When set, a standard header (title + close button) is rendered. */
  title?: React.ReactNode;
  /** Optional icon shown before the title. */
  titleIcon?: React.ReactNode;
  /** Optional secondary line under the title. */
  subtitle?: React.ReactNode;
  /** Max-width preset for the panel. Defaults to 'md'. */
  size?: ModalSize;
  /** Extra classes for the panel (e.g. an explicit height like `h-[80vh]`). */
  panelClassName?: string;
  /** Close when the backdrop is clicked. Defaults to true. */
  closeOnBackdrop?: boolean;
  /** Close when Escape is pressed. Defaults to true. */
  closeOnEscape?: boolean;
  /** Show the header close button (only relevant when `title` is set). Defaults to true. */
  showCloseButton?: boolean;
  /**
   * Accessible label for the dialog when no `title` is provided. Required for
   * screen readers on chrome-less modals.
   */
  ariaLabel?: string;
  /** Element to focus when the modal opens. Defaults to the first focusable element. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}

let openModalCount = 0;

const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  titleIcon,
  subtitle,
  size = 'md',
  panelClassName = '',
  closeOnBackdrop = true,
  closeOnEscape = true,
  showCloseButton = true,
  ariaLabel,
  initialFocusRef,
  children,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2)}`).current;

  // Lock body scroll while any modal is open (ref-counted for stacked modals).
  useEffect(() => {
    if (!isOpen) return;
    openModalCount += 1;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      openModalCount -= 1;
      if (openModalCount === 0) {
        document.body.style.overflow = previousOverflow;
      }
    };
  }, [isOpen]);

  // Save/restore focus and set the initial focus target.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Defer so the panel is mounted before we move focus into it.
    const raf = requestAnimationFrame(() => {
      const target =
        initialFocusRef?.current ??
        panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
        panelRef.current;
      target?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      previouslyFocused.current?.focus?.();
    };
  }, [isOpen, initialFocusRef]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEscape) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      // Focus trap: keep Tab focus cycling within the panel.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [closeOnEscape, onClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
      onMouseDown={closeOnBackdrop ? (e) => { if (e.target === e.currentTarget) onClose(); } : undefined}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`bg-surface-primary rounded-lg w-full ${SIZE_CLASSES[size]} max-h-[90vh] flex flex-col overflow-hidden focus:outline-none ${panelClassName}`}
      >
        {title && (
          <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              {titleIcon}
              <div className="min-w-0">
                <h3 id={titleId} className="text-lg font-semibold text-content-primary truncate">
                  {title}
                </h3>
                {subtitle && <p className="text-sm text-content-tertiary">{subtitle}</p>}
              </div>
            </div>
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className="p-1.5 text-content-tertiary hover:text-content-secondary rounded-md hover:bg-surface-secondary flex-shrink-0"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
};

export default Modal;
