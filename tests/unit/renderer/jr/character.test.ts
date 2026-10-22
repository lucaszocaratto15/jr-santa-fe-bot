import { expect, it } from 'vitest';
import {
  normalizeAppearance,
  characterSvg,
  CHARACTER_SHAPES,
  CHARACTER_COLORS,
} from '@/renderer/pages/Jr/botAppearance';

it('offers the observed thirteen shapes and eleven colors', () => {
  expect(CHARACTER_SHAPES).toHaveLength(13);
  expect(CHARACTER_COLORS).toHaveLength(11);
});

it('uses a safe default for unknown appearance metadata', () => {
  expect(normalizeAppearance({ shape: '<script>', color: 'url(https://example.com)' })).toEqual({
    shape: 'cloud',
    color: 'red',
  });
});

it('creates an independent animated SVG without external URLs or scripts', () => {
  const svg = characterSvg({ shape: 'heart', color: 'blue' });
  expect(svg).toContain('<svg');
  expect(svg).toContain('prefers-reduced-motion');
  expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/<script|https?:|url\(/i);
});
