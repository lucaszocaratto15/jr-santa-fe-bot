import type { JrAppearance } from '@/common/config/clientSettings';
import jrLogo from '@/renderer/assets/logos/jr-logo.png';
import jrMark from '@/renderer/assets/logos/jr-mark.png';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { characterImage, normalizeAppearance } from './botAppearance';
import styles from './JrWorkspace.module.css';

const LOGO_RATIO = 240 / 68;
/** Cropped official symbol, 260×180. */
const MARK_RATIO = 260 / 180;

const JrCharacter: React.FC<{ appearance?: JrAppearance; size?: number; still?: boolean }> = ({
  appearance,
  size = 40,
  still = false,
}) => (
  <img
    src={characterImage(normalizeAppearance(appearance), { animate: !still })}
    width={size}
    height={size}
    alt=''
    aria-hidden='true'
    className={styles.character}
  />
);

/** Wordmark, or the official JR symbol. The header uses the symbol so the name is not shrunk. */
export const JrLogo: React.FC<{ height?: number; className?: string; mark?: boolean }> = ({
  height = 28,
  className,
  mark = false,
}) => {
  const { t } = useTranslation();
  const width = Math.round(height * (mark ? MARK_RATIO : LOGO_RATIO));
  return (
    <img
      src={mark ? jrMark : jrLogo}
      alt={t('common.jr.companyName')}
      width={width}
      height={height}
      draggable={false}
      className={`${styles.logo} ${className ?? ''}`.trim()}
    />
  );
};

export default JrCharacter;
