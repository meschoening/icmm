/** The shell's icons. Strokes follow `currentColor`, so they theme with the text. */

export function LogoMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <circle cx="5" cy="11" r="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="17" cy="5" r="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="17" cy="17" r="3" fill="var(--brand)" />
      <path d="M7.7 9.6 14.3 6.4M7.7 12.4l6.6 3.2M17 8v6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="m9.5 9.5 3 3" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M3 5h1.2M7.8 5H15M3 9h7.2M13.8 9H15M3 13h3.2M9.8 13H15"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle cx="6" cy="5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="9" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="13" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
