import type { Metadata } from "next";
import { getLedgerView } from "@/lib/services/ledgerView";
import styles from "./ledger.module.css";

// Public page — no auth. It is a running gag made visible to people who have
// never heard an episode, which is the whole point of shipping it.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "The Attendance Ledger | Take Machine",
  description:
    "Every crowd figure Dutch \"Attendance\" Mulkey has announced, every real number Bernadette Zabala read back, and the running total of fans he has invented.",
};

const fmt = (n: number) => n.toLocaleString("en-US");

export default async function LedgerPage() {
  const ledger = await getLedgerView();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.kicker}>The Attendance Ledger</p>
        <h1 className={styles.title}>
          {fmt(ledger.phantomTotal)}
          <span className={styles.titleUnit}>phantom fans</span>
        </h1>
        <p className={styles.blurb}>
          Dutch &ldquo;Attendance&rdquo; Mulkey spent nineteen years as the public-address voice of the
          Wichita Wolverines. He announces crowd figures from two decades ago, unprompted, with
          absurd precision. He has never once rounded, and he has never once been right.
          Bernadette Zabala looks them up live.
        </p>
      </header>

      {ledger.isEmpty ? (
        // HONEST empty state. No sample rows, no projected total — the ledger
        // fills in as episodes are produced.
        <section className={styles.empty}>
          <p className={styles.emptyTitle}>The ledger is empty.</p>
          <p className={styles.emptyBody}>
            No episode has recorded an attendance claim yet. Entries appear here once an episode is
            produced and Mulkey has announced a figure Zabala could check.
          </p>
        </section>
      ) : (
        <>
          <section className={styles.statRow}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{fmt(ledger.episodesWithClaim)}</span>
              <span className={styles.statLabel}>episodes on record</span>
            </div>
            {ledger.biggest && (
              <div className={styles.stat}>
                <span className={styles.statValue}>{fmt(ledger.biggest.phantom)}</span>
                <span className={styles.statLabel}>biggest single invention</span>
              </div>
            )}
            <div className={styles.stat}>
              <span className={styles.statValue}>
                {fmt(Math.round(ledger.phantomTotal / ledger.episodesWithClaim))}
              </span>
              <span className={styles.statLabel}>average per episode</span>
            </div>
          </section>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.caption}>
                Every figure he has announced, against the real gate.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Episode</th>
                  <th scope="col" className={styles.num}>He announced</th>
                  <th scope="col" className={styles.num}>Actually there</th>
                  <th scope="col" className={styles.num}>Invented</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((e) => (
                  <tr key={e.episodeId}>
                    <th scope="row" className={styles.epCell}>
                      <span className={styles.epTitle}>{e.episodeTitle}</span>
                      {e.publishedAt && (
                        <time className={styles.epDate} dateTime={e.publishedAt.toISOString()}>
                          {e.publishedAt.toISOString().slice(0, 10)}
                        </time>
                      )}
                    </th>
                    <td className={styles.num}>{fmt(e.claimed)}</td>
                    <td className={`${styles.num} ${styles.real}`}>{fmt(e.real)}</td>
                    <td className={`${styles.num} ${styles.phantom}`}>+{fmt(e.phantom)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Lifetime</th>
                  <td className={styles.num} />
                  <td className={styles.num} />
                  <td className={`${styles.num} ${styles.phantom}`}>+{fmt(ledger.phantomTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      <footer className={styles.footer}>
        <a className={styles.cta} href="/rss">
          Listen to the show
        </a>
      </footer>
    </div>
  );
}
