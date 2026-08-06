/**
 * The icon set.
 *
 * Inline SVG rather than an icon font, for two reasons. A webfont is a runtime
 * request we refuse to make on demo day (see layout.tsx), and a webfont that
 * has not arrived yet renders as tofu boxes — half the meaning in this
 * interface is carried by its glyphs, so that failure is not survivable.
 *
 * Drawn on a 24×24 grid at stroke 1.5 with square joins: the same drafting
 * language as the hairline borders and 2px corners everywhere else. Every path
 * uses `currentColor`, so an icon is coloured by the text colour of whatever
 * contains it and the semantic palette applies to icons for free.
 */

export type IconName =
  | "shield"
  | "shieldOff"
  | "bot"
  | "gavel"
  | "key"
  | "terminal"
  | "bug"
  | "signal"
  | "network"
  | "store"
  | "receipt"
  | "warning"
  | "settings"
  | "book"
  | "wallet"
  | "history"
  | "rules"
  | "download"
  | "external"
  | "arrowRight"
  | "user"
  | "menu"
  | "close"
  | "lock"
  | "alert"
  | "check"
  | "plus"
  | "sound"
  | "mute";

const PATHS: Record<IconName, React.ReactNode> = {
  shield: <path d="M12 3.2 19 6v5.1c0 4.3-2.8 8-7 9.1-4.2-1.1-7-4.8-7-9.1V6z" />,
  shieldOff: (
    <>
      <path d="M12 3.2 19 6v5.1c0 4.3-2.8 8-7 9.1-4.2-1.1-7-4.8-7-9.1V6z" />
      <path d="M4.5 3.5 19.5 20.5" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4.8" />
      <circle cx="12" cy="3.6" r="1.2" />
      <path d="M9 12.5v1.5M15 12.5v1.5" />
      <path d="M9.5 17h5" />
    </>
  ),
  gavel: (
    <>
      <path d="M14.5 2.8 21 9.3l-2.6 2.6-6.5-6.5z" />
      <path d="M10.4 8.6 4 15l2.6 2.6 6.4-6.4" />
      <path d="M3 21.2h9" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="16.5" r="3.3" />
      <path d="M9.9 14.1 19.5 4.5" />
      <path d="M16.6 7.4 18.8 9.6" />
      <path d="M14.2 9.8 16.4 12" />
    </>
  ),
  terminal: (
    <>
      <path d="M5 7.5 9.8 12 5 16.5" />
      <path d="M12.5 17H19" />
    </>
  ),
  bug: (
    <>
      <rect x="8" y="8.5" width="8" height="11" rx="4" />
      <path d="M8 12H4.2M8 16H4.2M16 12h3.8M16 16h3.8" />
      <path d="M9.6 8.6 8 5.6M14.4 8.6 16 5.6" />
    </>
  ),
  signal: (
    <>
      <path d="M6.2 8.4a7.5 7.5 0 0 0 0 7.2" />
      <path d="M17.8 8.4a7.5 7.5 0 0 1 0 7.2" />
      <path d="M9 10.5a3.6 3.6 0 0 0 0 3" />
      <path d="M15 10.5a3.6 3.6 0 0 1 0 3" />
      <circle cx="12" cy="12" r="1.4" />
    </>
  ),
  network: (
    <>
      <rect x="9" y="2.8" width="6" height="4.6" />
      <rect x="2.5" y="16.6" width="6" height="4.6" />
      <rect x="15.5" y="16.6" width="6" height="4.6" />
      <path d="M12 7.4v4.4M5.5 16.6v-2.6h13v2.6M12 11.8v2.2" />
    </>
  ),
  store: (
    <>
      <path d="M4.5 9.5V20h15V9.5" />
      <path d="M3 9.5 4.6 4h14.8L21 9.5z" />
      <path d="M9.8 20v-5.4h4.4V20" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-3-1.8-3 1.8-3-1.8L6 21z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.6 21.2 20H2.8z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.2h.01" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
    </>
  ),
  book: (
    <>
      <path d="M4 4.2h6.2a2 2 0 0 1 1.8 1.1v14.5a2 2 0 0 0-1.8-1.1H4z" />
      <path d="M20 4.2h-6.2a2 2 0 0 0-1.8 1.1v14.5a2 2 0 0 1 1.8-1.1H20z" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10.2h18" />
      <circle cx="17" cy="14.6" r="1.2" />
    </>
  ),
  history: (
    <>
      <path d="M3.4 12a8.6 8.6 0 1 0 2.7-6.3" />
      <path d="M3 4.4v4.2h4.2" />
      <path d="M12 8v4.4l2.9 1.7" />
    </>
  ),
  rules: (
    <>
      <path d="M3.4 7.4 5.2 9.2 8.4 6" />
      <path d="M3.4 15.4 5.2 17.2 8.4 14" />
      <path d="M11.6 8h9M11.6 16h9" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.6v10.6" />
      <path d="M7.8 10.4 12 14.6l4.2-4.2" />
      <path d="M4.4 19.4h15.2" />
    </>
  ),
  external: (
    <>
      <path d="M13.6 3.6H20.4v6.8" />
      <path d="M20.4 3.6 11.4 12.6" />
      <path d="M18 13.6V20H4V6h6.4" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M4.4 12h14.4" />
      <path d="M12.6 5.8 18.8 12l-6.2 6.2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.8" />
      <path d="M4.4 20.6c0-4.2 3.4-6.8 7.6-6.8s7.6 2.6 7.6 6.8" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  lock: (
    <>
      <rect x="4.8" y="10.6" width="14.4" height="9.4" rx="1.6" />
      <path d="M8.2 10.6V7.4a3.8 3.8 0 0 1 7.6 0v3.2" />
    </>
  ),
  alert: (
    <>
      <path d="M8.3 2.8h7.4l5.5 5.5v7.4l-5.5 5.5H8.3l-5.5-5.5V8.3z" />
      <path d="M12 7.6v5" />
      <path d="M12 15.8h.01" />
    </>
  ),
  check: <path d="M4.6 12.4 9.4 17.2 19.4 7.2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  sound: (
    <>
      <path d="M4 9.4h3.4L12 5.4v13.2l-4.6-4H4z" />
      <path d="M15.6 9.6a3.4 3.4 0 0 1 0 4.8" />
      <path d="M18.2 7a7 7 0 0 1 0 10" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.4h3.4L12 5.4v13.2l-4.6-4H4z" />
      <path d="M16.4 9.8 21 14.4M21 9.8l-4.6 4.6" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  className = "",
  strokeWidth = 1.5,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {PATHS[name]}
    </svg>
  );
}
