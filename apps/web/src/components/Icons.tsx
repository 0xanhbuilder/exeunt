import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 18, className, children, viewBox = "0 0 24 24" }: IconProps & { children: ReactNode; viewBox?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function LogoMark({ size = 30 }: IconProps) {
  return (
    <Svg size={size} viewBox="0 0 30 30" className="logo-mark">
      <rect x="4" y="3" width="13" height="24" rx="1" />
      <path d="M14 15h12" />
      <path d="M22 11l4 4-4 4" />
    </Svg>
  );
}

export function ChevronDown(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

export function ArrowRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </Svg>
  );
}

export function CodeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
    </Svg>
  );
}

export function Check(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12l5 5 9-10" />
    </Svg>
  );
}

export function Cross(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Svg>
  );
}

export function Lock(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function FlowArrow() {
  return (
    <svg className="flow-arrow" width="44" height="24" viewBox="0 0 44 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12h38" />
      <path d="M32 5l8 7-8 7" />
    </svg>
  );
}

export function PathIcon({ d, size = 22 }: { d: string; size?: number }) {
  return (
    <Svg size={size}>
      <path d={d} />
    </Svg>
  );
}
