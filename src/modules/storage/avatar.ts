import { createHash } from 'node:crypto';

interface Palette {
  background: string;
  body: string;
  accent: string;
}

const PALETTE: Palette[] = [
  { background: '#EDE9FE', body: '#5B21B6', accent: '#F59E0B' },
  { background: '#DCFCE7', body: '#166534', accent: '#DB2777' },
  { background: '#FEF3C7', body: '#92400E', accent: '#2563EB' },
  { background: '#DBEAFE', body: '#1E3A8A', accent: '#F97316' },
  { background: '#FCE7F3', body: '#9D174D', accent: '#0EA5E9' },
  { background: '#E0F2FE', body: '#075985', accent: '#16A34A' },
  { background: '#FEE2E2', body: '#991B1B', accent: '#7C3AED' },
  { background: '#F3E8FF', body: '#6B21A8', accent: '#059669' },
];

const FALLBACK: Palette = { background: '#E4E4E7', body: '#3F3F46', accent: '#71717A' };

const hashSeed = (seed: string): number =>
  createHash('sha256').update(seed).digest().readUInt32BE(0);

export const pickPalette = (seed: string): Palette => {
  const hash = hashSeed(seed);
  return PALETTE[hash % PALETTE.length] ?? FALLBACK;
};

/**
 * Renders a deterministic bug-icon avatar. No external image service is involved: the same
 * seed always produces the same icon, and colours come from a small curated palette.
 */
export const renderBugAvatar = (seed: string): string => {
  try {
    const palette = pickPalette(seed);
    const hash = hashSeed(seed);
    const variant = hash % 3;
    const spotOffset = 18 + (hash % 10);

    const antennae =
      variant === 0
        ? `<path d="M212 128 C196 96 178 78 154 66" stroke="${palette.body}" stroke-width="14" stroke-linecap="round" fill="none"/>
           <path d="M300 128 C316 96 334 78 358 66" stroke="${palette.body}" stroke-width="14" stroke-linecap="round" fill="none"/>
           <circle cx="150" cy="63" r="15" fill="${palette.accent}"/>
           <circle cx="362" cy="63" r="15" fill="${palette.accent}"/>`
        : variant === 1
          ? `<path d="M214 126 C206 92 196 72 176 52" stroke="${palette.body}" stroke-width="14" stroke-linecap="round" fill="none"/>
             <path d="M298 126 C306 92 316 72 336 52" stroke="${palette.body}" stroke-width="14" stroke-linecap="round" fill="none"/>
             <circle cx="172" cy="48" r="16" fill="${palette.accent}"/>
             <circle cx="340" cy="48" r="16" fill="${palette.accent}"/>`
          : `<path d="M206 132 C186 110 168 96 140 88" stroke="${palette.body}" stroke-width="14" stroke-linecap="round" fill="none"/>
             <path d="M306 132 C326 110 344 96 372 88" stroke="${palette.body}" stroke-width="14" stroke-linecap="round" fill="none"/>
             <circle cx="136" cy="86" r="15" fill="${palette.accent}"/>
             <circle cx="376" cy="86" r="15" fill="${palette.accent}"/>`;

    const spots =
      variant === 2
        ? `<circle cx="${256 - spotOffset}" cy="300" r="16" fill="${palette.accent}" opacity="0.9"/>
           <circle cx="${256 + spotOffset}" cy="330" r="12" fill="${palette.accent}" opacity="0.9"/>`
        : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Bug avatar">
  <rect width="512" height="512" rx="112" fill="${palette.background}"/>
  <g>
    <rect x="96" y="250" width="70" height="20" rx="10" fill="${palette.body}" transform="rotate(-18 131 260)"/>
    <rect x="92" y="306" width="74" height="20" rx="10" fill="${palette.body}" transform="rotate(-4 129 316)"/>
    <rect x="100" y="360" width="66" height="20" rx="10" fill="${palette.body}" transform="rotate(14 133 370)"/>
    <rect x="346" y="250" width="70" height="20" rx="10" fill="${palette.body}" transform="rotate(18 381 260)"/>
    <rect x="346" y="306" width="74" height="20" rx="10" fill="${palette.body}" transform="rotate(4 383 316)"/>
    <rect x="346" y="360" width="66" height="20" rx="10" fill="${palette.body}" transform="rotate(-14 379 370)"/>
  </g>
  ${antennae}
  <ellipse cx="256" cy="300" rx="116" ry="132" fill="${palette.body}"/>
  <circle cx="256" cy="150" r="70" fill="${palette.body}"/>
  <path d="M256 214 L256 250" stroke="${palette.accent}" stroke-width="12" stroke-linecap="round"/>
  ${spots}
  <circle cx="228" cy="142" r="17" fill="${palette.background}"/>
  <circle cx="284" cy="142" r="17" fill="${palette.background}"/>
  <circle cx="232" cy="146" r="7" fill="${palette.body}"/>
  <circle cx="288" cy="146" r="7" fill="${palette.body}"/>
  <path d="M232 184 Q256 200 280 184" stroke="${palette.background}" stroke-width="10" stroke-linecap="round" fill="none"/>
</svg>`;
  } catch {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Bug avatar">
  <rect width="512" height="512" rx="112" fill="${FALLBACK.background}"/>
  <ellipse cx="256" cy="300" rx="116" ry="132" fill="${FALLBACK.body}"/>
  <circle cx="256" cy="150" r="70" fill="${FALLBACK.body}"/>
  <circle cx="228" cy="142" r="17" fill="${FALLBACK.background}"/>
  <circle cx="284" cy="142" r="17" fill="${FALLBACK.background}"/>
</svg>`;
  }
};
