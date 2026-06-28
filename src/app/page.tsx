import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.container}>
      <main className={styles.main}>
        <h1 className={styles.title}>TAKE MACHINE</h1>
        <p className={styles.subtitle}>
          The production-ready AI sports debate podcast generation platform. 
          Generate briefings, write scripts, fact-check arguments, synthesize host audio, and publish dynamically.
        </p>
        <Link href="/admin" className={styles.button}>
          Enter Command Center
        </Link>
      </main>
    </div>
  );
}
