const common = {
  viewBox: "0 0 24 24",
  "aria-hidden": true,
  focusable: false,
} as const;

export function MicIcon() {
  return (
    <svg {...common} className="icon" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg {...common} className="icon" fill="currentColor">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg {...common} className="icon" fill="currentColor">
      <path d="M8 5.2v13.6L19 12z" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg {...common} className="icon" fill="currentColor">
      <rect x="6.5" y="5" width="4" height="14" rx="1.2" />
      <rect x="13.5" y="5" width="4" height="14" rx="1.2" />
    </svg>
  );
}

export function NextIcon() {
  return (
    <svg {...common} className="icon" fill="currentColor">
      <path d="M5.5 5.5v13l9-6.5z" />
      <rect x="15.5" y="5.5" width="3" height="13" rx="1" />
    </svg>
  );
}

export function SpeakerIcon() {
  return (
    <svg {...common} className="icon" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  );
}
