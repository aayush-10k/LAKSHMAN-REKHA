'use client';

import { useSound } from '../lib/sound';

/**
 * The mute control.
 *
 * Present on both app surfaces, and deliberately a real control rather than a
 * setting hidden in a menu: sound plays unprompted here, so switching it off has
 * to be one obvious click. It carries the same ghost-button treatment as every
 * other secondary control, so it reads as part of the product rather than a
 * browser affordance.
 *
 * Glyphs, not emoji — an emoji renders at a different size and weight on every
 * platform and would be the only one in the interface.
 *
 * The label says what pressing it DOES, which is the rule the rest of the
 * product's copy follows. `aria-pressed` carries the current state for anyone
 * who cannot see the dimming.
 */
export function SoundToggle({ className }: { className?: string }) {
  const { enabled, toggle } = useSound();

  return (
    <button
      type="button"
      className={`fx-sound fx-tip-left ${className ?? ''}`}
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={enabled ? 'Turn sound off' : 'Turn sound on'}
      data-tip={enabled ? 'Turn sound off' : 'Turn sound on'}
    >
      <span aria-hidden="true">{enabled ? '♪' : '✕'}</span>
    </button>
  );
}
