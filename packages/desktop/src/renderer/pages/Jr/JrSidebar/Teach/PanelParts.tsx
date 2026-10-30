import { Skeleton } from '@arco-design/web-react';
import React from 'react';
import styles from '../JrSidebar.module.css';

/** Page title with an optional subtitle and right-side actions. */
export const PageHeader: React.FC<{ title: React.ReactNode; subtitle?: React.ReactNode; aside?: React.ReactNode }> = ({
  title,
  subtitle,
  aside,
}) => (
  <header className={styles.pageHead}>
    <div className={styles.pageHeadCopy}>
      <h2 className={styles.pageTitle}>{title}</h2>
      {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
    </div>
    {aside && <div className={styles.pageHeadAside}>{aside}</div>}
  </header>
);

/** Small heading above a card, with optional actions on the right. */
export const SectionLabel: React.FC<{ children: React.ReactNode; aside?: React.ReactNode }> = ({ children, aside }) => (
  <div className={styles.sectionLabel}>
    <h3 className='m-0 flex-1 text-13px font-500'>{children}</h3>
    {aside}
  </div>
);

/** Centered icon, title and hint shown when a list has nothing yet. */
export const EmptyState: React.FC<{
  icon: React.ReactNode;
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}> = ({ icon, title, hint, action }) => (
  <div className={styles.empty}>
    <span className={styles.emptyIcon}>{icon}</span>
    <p className={styles.emptyTitle}>{title}</p>
    {hint && <p className={styles.emptyHint}>{hint}</p>}
    {action && <div className={styles.emptyAction}>{action}</div>}
  </div>
);

/** Placeholder rows while a list loads. */
export const SkeletonRows: React.FC<{ count?: number }> = ({ count = 3 }) => (
  <div>
    {Array.from({ length: count }, (_, index) => (
      <div key={index} className={styles.skeletonRow}>
        <Skeleton animation text={{ rows: 2, width: ['40%', '70%'] }} />
      </div>
    ))}
  </div>
);
