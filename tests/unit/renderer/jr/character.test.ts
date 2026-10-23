import { readFileSync } from 'node:fs';
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

it('keeps a picker pose still so the shape stays in the center of its box', () => {
  const still = characterSvg({ shape: 'cloud', color: 'red' }, { animate: false });
  expect(still).not.toContain('translateY');
  expect(still).not.toContain('rotate(');
  expect(characterSvg({ shape: 'cloud', color: 'red' })).toContain('translateY(2px) rotate(-7deg)');
});

it('paints the shape highlight on the same centered box as the shape', () => {
  const css = readFileSync('packages/desktop/src/renderer/pages/Jr/JrWorkspace.module.css', 'utf8');
  expect(css).toMatch(/\.shapeChoice:global\(\.arco-btn\)\s*\{[^}]*align-items:\s*center/);
  expect(css).toMatch(/\.shapeChoice:global\(\.arco-btn\)\s*\{[^}]*justify-content:\s*center/);
  expect(css).toMatch(/\.shapeMark\s*\{[^}]*place-items:\s*center/);
  expect(css).toMatch(/\.shapeMarkOn\s*\{[^}]*box-shadow:\s*0 0 0 6px/);
});
