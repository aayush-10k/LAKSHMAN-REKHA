'use client';

import { useSound } from '../lib/sound';
import { Icon } from './Icon';

/**
 * The mute control.
 *
 * Deliberately a real control rather than a setting hidden in a menu: sound
 * plays unprompted here, so switching it off has to be one obvious click.
 *
 * The label says what pressing it DOES, which is the rule the rest of the
 * product's copy follows. `aria-pressed` carries the current state for anyone
 * who cannot see the icon change.
 */
export function SoundToggle({ className = '' }: { className?: string }) {
  const { enabled, toggle } = useSound();

  return (
    <button
      type="button"
      className={`flex items-center justify-center rounded-sm p-2 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary active:scale-95 ${className}`}
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={enabled ? 'Turn sound off' : 'Turn sound on'}
      title={enabled ? 'Turn sound off' : 'Turn sound on'}
    >
      <Icon name={enabled ? 'sound' : 'mute'} size={18} />
    </button>
  );
}
