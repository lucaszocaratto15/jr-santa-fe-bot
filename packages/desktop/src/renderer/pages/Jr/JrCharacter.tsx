import type { JrAppearance } from '@/common/config/clientSettings';
import jrLogo from '@/renderer/assets/logos/jr-logo.png';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { characterImage, normalizeAppearance } from './botAppearance';
import styles from './JrWorkspace.module.css';

const LOGO_RATIO = 240 / 68;

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

/** Full JR wordmark at its real aspect ratio, centered and uncropped. */
export const JrLogo: React.FC<{ height?: number; className?: string }> = ({ height = 28, className }) => {
  const { t } = useTranslation();
  const width = Math.round(height * LOGO_RATIO);
  return (
    <img
      src={jrLogo}
      alt={t('common.jr.companyName')}
      width={width}
      height={height}
      draggable={false}
      className={`${styles.logo} ${className ?? ''}`.trim()}
    />
  );
};

export default JrCharacter;
