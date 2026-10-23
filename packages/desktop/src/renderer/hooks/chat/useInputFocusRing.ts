/**
 * Composer focus ring. A JR-red hairline in both themes, with no blue or purple glow.
 */
export const useInputFocusRing = () => {
  return {
    activeBorderColor: 'var(--jr-accent)',
    inactiveBorderColor: 'var(--jr-border)',
    activeShadow: '0 0 0 1px color-mix(in srgb, var(--jr-accent) 40%, transparent)',
  };
};
