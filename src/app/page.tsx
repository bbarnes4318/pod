import Link from "next/link";
import styles from "./page.module.css";

// Deterministic bar heights for the decorative waveform (no Math.random —
// keeps server/client render identical).
const WAVE = [18, 42, 30, 64, 24, 80, 48, 36, 90, 56, 28, 70, 40, 96, 60, 32, 78, 44, 22, 66, 38, 84, 52, 26, 72, 46, 34, 88, 58, 20, 62, 42];

export default function Home() {
  return (
    <div className={styles.container}>
      <main className={styles.main}>
        <div className={styles.onAir}>
          <span className="onAirDot" aria-hidden="true" />
          On Air
        </div>
        <h1 className={styles.title}>
          Turn hot takes into <em>episodes</em>
        </h1>
        <p className={styles.subtitle}>
          Pick tonight&apos;s most argued-about story. Take Machine researches it,
          writes the debate, voices both hosts, and hands you a finished,
          scored episode — ready to publish.
        </p>
        <Link href="/studio" className={styles.button}>
          Open the Studio
        </Link>
        <Link href="/rss" className={styles.secondary}>
          Listen to the feed
        </Link>
      </main>

      <div className={styles.waveRow} aria-hidden="true">
        {WAVE.map((h, i) => (
          <span key={i} style={{ ["--h" as never]: `${h}px`, animationDelay: `${(i % 7) * 0.12}s` }} />
        ))}
      </div>
    </div>
  );
}
