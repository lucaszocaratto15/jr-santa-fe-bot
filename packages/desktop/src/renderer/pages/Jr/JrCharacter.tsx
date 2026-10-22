import type { JrAppearance } from '@/common/config/clientSettings';
import React from 'react';
import { characterImage, normalizeAppearance } from './botAppearance';
import styles from './JrWorkspace.module.css';

const JrCharacter: React.FC<{ appearance?: JrAppearance; size?: number }> = ({ appearance, size = 40 }) => (
  <img
    src={characterImage(normalizeAppearance(appearance))}
    width={size}
    height={size}
    alt=''
    aria-hidden='true'
    className={styles.character}
  />
);
export default JrCharacter;
