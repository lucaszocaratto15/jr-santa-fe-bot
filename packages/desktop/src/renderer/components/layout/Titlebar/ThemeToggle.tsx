import { DARK_THEME_ID, LIGHT_THEME_ID } from '@/common/theme/constants';
import { Button } from '@arco-design/web-react';
import { Moon, SunOne } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';

/** Light / dark switch next to the 🧠 indicator. */
const ThemeToggle: React.FC = () => {
  const { t } = useTranslation();
  const { theme, setTheme } = useThemeContext();
  const dark = theme === 'dark';
  return (
    <Button
      type='text'
      shape='circle'
      size='small'
      className='app-titlebar__theme'
      aria-label={t('common.jr.look.toggleTheme')}
      title={t('common.jr.look.toggleTheme')}
      icon={dark ? <SunOne theme='outline' size={16} /> : <Moon theme='outline' size={16} />}
      onClick={() => void setTheme(dark ? LIGHT_THEME_ID : DARK_THEME_ID)}
    />
  );
};

export default ThemeToggle;
