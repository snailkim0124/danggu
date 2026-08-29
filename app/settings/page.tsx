import Link from 'next/link';
import Settings from '@/components/Settings';
import styles from '../page.module.css';

export default function SettingsPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.backLink}>
          ← 뒤로
        </Link>
        <h1 className={styles.headerTitle}>설정</h1>
      </header>
      <main className={styles.main}>
        <Settings />
      </main>
    </div>
  );
}
