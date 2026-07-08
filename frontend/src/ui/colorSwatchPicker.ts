// A small reusable "swatch + popover" color picker: a round button showing
// the current color, which opens a popover containing a preset palette grid,
// a native color wheel (fallback/custom-color option), and a hex text input
// (for typing an exact value). Selecting a palette swatch, picking via the
// wheel, or confirming a hex value all update the color via `onChange`.
//
// Built with vanilla DOM APIs only — no popover/color-picker library, to
// match this app's plain TS + CSS stack (no framework).
//
// Ported (pattern only — this is vanilla TS/DOM, the reference is
// React/Tailwind/shadcn) from a sibling project's component:
// fynance/frontend/src/components/color_swatch_picker.tsx.

const PALETTE = [
  '#22c55e', '#3b82f6', '#f97316', '#06b6d4',
  '#ec4899', '#a855f7', '#eab308', '#14b8a6',
  '#6366f1', '#f43f5e', '#d946ef', '#0ea5e9',
  '#78716c', '#84cc16', '#f59e0b', '#10b981',
] as const;

const HEX_RE = /^#[0-9a-f]{6}$/i;

let uidCounter = 0;
function nextId(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

export interface ColorSwatchPickerHandle {
  element: HTMLElement;
  setColor: (color: string) => void;
}

export function createColorSwatchPicker(opts: {
  initialColor: string;
  label: string;
  onChange: (color: string) => void;
}): ColorSwatchPickerHandle {
  let color = opts.initialColor;

  const wrap = document.createElement('div');
  wrap.className = 'color-swatch-picker';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'color-swatch-button';
  button.style.backgroundColor = color;
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', opts.label);
  button.title = opts.label;

  const popover = document.createElement('div');
  popover.className = 'color-swatch-popover';
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', `${opts.label} picker`);
  // Fallback focus target for open()/the Tab trap in the (should-never-
  // happen) case the popover has no focusable children.
  popover.tabIndex = -1;

  const heading = document.createElement('p');
  heading.className = 'color-swatch-popover-label';
  heading.textContent = opts.label;
  popover.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'color-swatch-grid';
  const paletteEntries: { button: HTMLButtonElement; value: string }[] = [];
  for (const presetColor of PALETTE) {
    const swatchBtn = document.createElement('button');
    swatchBtn.type = 'button';
    swatchBtn.className = 'color-swatch-option';
    swatchBtn.style.backgroundColor = presetColor;
    swatchBtn.setAttribute('aria-label', presetColor);
    swatchBtn.addEventListener('click', () => {
      setColorInternal(presetColor, true);
      close();
    });
    paletteEntries.push({ button: swatchBtn, value: presetColor });
    grid.appendChild(swatchBtn);
  }
  popover.appendChild(grid);

  const customRow = document.createElement('div');
  customRow.className = 'color-swatch-custom-row';

  const wheelId = nextId('color-swatch-wheel');
  const wheelLabel = document.createElement('label');
  wheelLabel.className = 'color-swatch-wheel-label';
  wheelLabel.setAttribute('for', wheelId);
  const wheel = document.createElement('input');
  wheel.type = 'color';
  wheel.id = wheelId;
  wheel.className = 'color-swatch-wheel-input';
  wheel.value = normalizeForNativeInput(color);
  wheel.addEventListener('input', () => {
    setColorInternal(wheel.value, true);
  });
  const wheelSrText = document.createElement('span');
  wheelSrText.className = 'sr-only';
  wheelSrText.textContent = 'Custom color (wheel)';
  wheelLabel.append(wheel, wheelSrText);

  const hexId = nextId('color-swatch-hex');
  const hexLabel = document.createElement('label');
  hexLabel.className = 'color-swatch-hex-label';
  hexLabel.setAttribute('for', hexId);
  hexLabel.textContent = 'Hex';
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.id = hexId;
  hexInput.className = 'color-swatch-hex-input';
  hexInput.maxLength = 7;
  hexInput.spellcheck = false;
  hexInput.autocomplete = 'off';
  hexInput.value = color;

  function commitHex(): boolean {
    const raw = hexInput.value.trim();
    const withHash = raw.startsWith('#') ? raw : `#${raw}`;
    if (HEX_RE.test(withHash)) {
      setColorInternal(withHash.toLowerCase(), true);
      return true;
    }
    hexInput.value = color; // revert to last-known-good
    return false;
  }
  hexInput.addEventListener('blur', () => {
    commitHex();
  });
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (commitHex()) {
        close();
      }
    } else if (e.key === 'Escape') {
      hexInput.value = color;
      close();
    }
  });

  customRow.append(wheelLabel, hexLabel, hexInput);
  popover.appendChild(customRow);

  wrap.append(button);
  // The popover is deliberately appended to <body> (not `wrap`) and
  // positioned with `position: fixed`, computed from the button's rect each
  // time it opens. QR Studio's controls column scrolls internally
  // (`.controls { overflow-y: auto }`); a popover positioned `absolute`
  // relative to an ancestor inside that column would get silently clipped
  // to the scrollable area's bounds instead of floating freely above it.
  document.body.appendChild(popover);

  function normalizeForNativeInput(c: string): string {
    return HEX_RE.test(c) ? c : '#000000';
  }

  function updatePaletteSelection(): void {
    const lower = color.toLowerCase();
    for (const entry of paletteEntries) {
      entry.button.classList.toggle('is-selected', entry.value.toLowerCase() === lower);
    }
  }

  function setColorInternal(next: string, notify: boolean): void {
    color = next;
    button.style.backgroundColor = color;
    wheel.value = normalizeForNativeInput(color);
    hexInput.value = color;
    updatePaletteSelection();
    if (notify) opts.onChange(color);
  }

  function onDocumentClick(e: MouseEvent): void {
    const target = e.target as Node;
    if (!wrap.contains(target) && !popover.contains(target)) close();
  }
  function getFocusableElements(): HTMLElement[] {
    return Array.from(
      popover.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')
    ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
  }

  function onDocumentKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key === 'Tab') {
      // Focus trap: while the popover is open, Tab/Shift+Tab must cycle only
      // among its own focusable controls (palette swatches -> wheel -> hex
      // input), never escaping into background page controls.
      const focusable = getFocusableElements();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  // The popover lives in `document.body` with `position: fixed`, positioned
  // from the button's rect at open time — it doesn't track the button's
  // position on scroll (e.g. scrolling the `.controls` column the button
  // lives in). Closing on any scroll (capture-phase, so it also catches
  // scroll events on non-bubbling scroll containers like `.controls`) is
  // simpler and more robust than repositioning on every scroll tick.
  function onWindowScrollOrResize(): void {
    close();
  }

  function reposition(): void {
    const rect = button.getBoundingClientRect();
    const popoverWidth = 232;
    let left = rect.left;
    if (left + popoverWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - popoverWidth - 8);
    }
    popover.style.left = `${left}px`;

    // Vertical clamping mirrors the horizontal logic above. Requires the
    // popover to already be laid out (not `hidden`) so its real height is
    // measurable — callers must reveal-but-hide-visually before calling
    // this (see open()).
    const popoverHeight = popover.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;

    let top: number;
    if (popoverHeight <= spaceBelow) {
      // Default: open below the button.
      top = rect.bottom + 8;
    } else if (popoverHeight <= spaceAbove) {
      // Doesn't fit below but does above — flip.
      top = rect.top - 8 - popoverHeight;
    } else {
      // Fits neither fully (tiny viewport / button near both edges) — use
      // whichever side has more room, then clamp so it's never rendered
      // fully off-screen in either direction.
      top = spaceBelow >= spaceAbove ? rect.bottom + 8 : rect.top - 8 - popoverHeight;
      top = Math.max(8, Math.min(top, window.innerHeight - popoverHeight - 8));
    }
    popover.style.top = `${top}px`;
  }

  function open(): void {
    // Make the popover measurable (laid out) without visibly flashing it in
    // the wrong spot: reveal it invisibly, measure + position, then reveal
    // visually. `hidden` can't be measured; toggling `hidden` off first
    // (with `visibility: hidden` masking it) avoids both problems.
    popover.style.visibility = 'hidden';
    popover.hidden = false;
    reposition();
    popover.style.visibility = '';

    button.setAttribute('aria-expanded', 'true');
    hexInput.value = color;
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onDocumentKeydown, true);
    window.addEventListener('scroll', onWindowScrollOrResize, true);
    window.addEventListener('resize', onWindowScrollOrResize, true);

    // Move focus into the popover (first palette swatch is the most useful
    // landing spot) so keyboard users land inside the trap immediately.
    const focusable = getFocusableElements();
    (focusable[0] ?? popover).focus();
  }
  function close(): void {
    if (popover.hidden) return;
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onDocumentKeydown, true);
    window.removeEventListener('scroll', onWindowScrollOrResize, true);
    window.removeEventListener('resize', onWindowScrollOrResize, true);
    // Every close path (Escape, outside-click, palette selection, hex
    // commit/cancel) returns focus to the trigger button consistently.
    button.focus();
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover.hidden) open();
    else close();
  });

  updatePaletteSelection();

  return {
    element: wrap,
    setColor: (next: string) => setColorInternal(next, false),
  };
}
