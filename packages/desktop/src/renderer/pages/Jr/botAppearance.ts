import type { JrAppearance, JrColor, JrShape } from '@/common/config/clientSettings';

export const CHARACTER_SHAPES: JrShape[] = [
  'bubble',
  'cloud',
  'square',
  'sparkle',
  'clover',
  'heart',
  'flower',
  'drop',
  'pill',
  'wedge',
  'house',
  'star',
  'hexagon',
];
export const CHARACTER_COLORS: JrColor[] = [
  'black',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'gray',
];
export const CHARACTER_PALETTE: Record<JrColor, string> = {
  black: '#242326',
  brown: '#a57549',
  red: '#e43651',
  orange: '#ff791f',
  yellow: '#ffb525',
  green: '#23bf7d',
  cyan: '#16b8b3',
  blue: '#338cf1',
  violet: '#9562ed',
  magenta: '#ed3f9a',
  gray: '#949494',
};
const paths: Record<JrShape, string> = {
  bubble: 'M50 5C78 5 96 24 96 51S77 96 50 96 5 76 5 50 23 5 50 5Z',
  cloud:
    'M28 10C42 1 58 7 63 12 82 6 95 22 90 37 104 52 96 71 83 76 79 95 58 99 45 91 26 100 11 86 13 73-3 60 3 39 16 33 13 23 18 14 28 10Z',
  square: 'M22 6H78Q94 6 94 22V78Q94 94 78 94H22Q6 94 6 78V22Q6 6 22 6Z',
  sparkle: 'M50 3C61 3 61 26 69 31S97 40 97 50 74 61 69 69 61 97 50 97 39 74 31 69 3 61 3 50 26 39 31 31 39 3 50 3Z',
  clover: 'M50 20C73-10 106 27 80 50 110 72 73 110 50 80 27 110-10 73 20 50-10 27 27-10 50 20Z',
  heart: 'M50 92C37 80 4 58 4 32 4 8 34 0 50 21 66 0 96 8 96 32 96 58 63 80 50 92Z',
  flower:
    'M50 5C63 5 66 18 66 24 85 9 99 27 83 43 109 49 101 74 80 72 86 97 60 104 50 82 40 104 14 97 20 72-1 74-9 49 17 43 1 27 15 9 34 24 34 18 37 5 50 5Z',
  drop: 'M50 4C63 19 94 44 94 66 94 105 6 105 6 66 6 44 37 19 50 4Z',
  pill: 'M38 11H62C108 11 108 89 62 89H38C-8 89-8 11 38 11Z',
  wedge: 'M20 8C29 3 91 59 94 72 98 94 19 103 8 84-1 69 10 13 20 8Z',
  house: 'M16 34 43 8Q50 1 57 8L84 34Q94 42 94 53V82Q94 94 82 94H18Q6 94 6 82V53Q6 42 16 34Z',
  star: 'M50 4 63 30 92 34Q100 36 94 43L74 63 79 91Q80 100 72 96L50 84 28 96Q20 100 21 91L26 63 6 43Q0 36 8 34L37 30Z',
  hexagon: 'M30 6H70Q78 6 82 14L97 43Q101 50 97 57L82 86Q78 94 70 94H30Q22 94 18 86L3 57Q-1 50 3 43L18 14Q22 6 30 6Z',
};

export function normalizeAppearance(value?: { shape?: string; color?: string }): JrAppearance {
  return {
    shape: CHARACTER_SHAPES.includes(value?.shape as JrShape) ? (value!.shape as JrShape) : 'cloud',
    color: CHARACTER_COLORS.includes(value?.color as JrColor) ? (value!.color as JrColor) : 'red',
  };
}

/** Own vector geometry; no third-party artwork or runtime script. */
export function characterSvg(value: JrAppearance, options?: { animate?: boolean }): string {
  const appearance = normalizeAppearance(value);
  const eyes = appearance.color === 'black' ? '#ffffff' : '#242326';
  const animate = options?.animate !== false;
  const motion = animate
    ? '<style>.body{transform-origin:50px 55px;animation:float 3.6s ease-in-out infinite}.eyes{transform-origin:50px 49px;animation:blink 5.2s infinite}@keyframes float{0%,100%{transform:translateY(2px) rotate(-7deg)}50%{transform:translateY(-2px) rotate(7deg)}}@keyframes blink{0%,44%,48%,100%{transform:scaleY(1)}46%{transform:scaleY(.08)}}@media(prefers-reduced-motion:reduce){.body,.eyes{animation:none}}</style>'
    : '';
  // A still pose keeps the path centered in the viewBox. The float keyframe
  // starts translated and rotated, which shifts every shape off the highlight.
  const group = animate ? ' class="body"' : '';
  const eyeGroup = animate ? ' class="eyes"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 108 108">${motion}<g${group}><path fill="${CHARACTER_PALETTE[appearance.color]}" d="${paths[appearance.shape]}"/><g${eyeGroup} fill="${eyes}"><rect x="35" y="38" width="8" height="23" rx="4"/><rect x="57" y="38" width="8" height="23" rx="4"/></g></g></svg>`;
}

export function characterImage(appearance: JrAppearance, options?: { animate?: boolean }): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(characterSvg(appearance, options))}`;
}
