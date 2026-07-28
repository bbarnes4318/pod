import type { Metadata } from "next";
import { getLedgerView } from "@/lib/services/ledgerView";
import styles from "./ledger.module.css";

// Public page — no auth. It is the show's running character arc made visible to
// people who have never heard an episode, which is the whole point of shipping it.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "The Language Ledger | Take Machine",
  description:
    "Every phrase Cal Mercer reached for when a story got uncomfortable, what he was covering when he said it, and the ones he has since taken back.",
};

const fmt = (n: number) => n.toLocaleString("en-US");

const STATUS_LABEL: Record<string, string> = {
  used: "Still stands",
  rejected: "Took it back",
  revised: "Rewrote it",
};

export default async function LedgerPage() {
  const ledger = await getLedgerView();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.kicker}>The Language Ledger</p>
        <h1 className={styles.title}>
          {fmt(ledger.phraseCount)}
          <span className={styles.titleUnit}>phrases on record</span>
        </h1>
        <p className={styles.blurb}>
          Cal Mercer spent seventeen years inside sports organizations, and he learned the vocabulary
          those rooms use when a decision goes wrong. Every time he reaches for one of those phrases
          on this show, it goes here. Bernadette Zabala can bring any of them back.
        </p>
      </header>

      {ledger.isEmpty ? (
        // HONEST empty state. No sample rows, no projected total — the ledger
        // fills in as episodes are produced.
        <section className={styles.empty}>
          <p className={styles.emptyTitle}>The ledger is empty.</p>
          <p className={styles.emptyBody}>
            No episode has recorded a phrase yet. Entries appear here once an episode is produced and
            Cal has reached for language that covers something.
          </p>
        </section>
      ) : (
        <>
          <section className={styles.statRow}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{fmt(ledger.episodesWithEntry)}</span>
              <span className={styles.statLabel}>episodes on record</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{fmt(ledger.takenBackCount)}</span>
              <span className={styles.statLabel}>since taken back</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>
                {fmt(ledger.phraseCount - ledger.takenBackCount)}
              </span>
              <span className={styles.statLabel}>still standing</span>
            </div>
          </section>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.caption}>
                Every phrase he reached for, and what it was covering.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Episode</th>
                  <th scope="col">He said</th>
                  <th scope="col">About</th>
                  <th scope="col">Since</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((e, i) => (
                  <tr key={`${e.episodeId}-${i}`}>
                    <th scope="row" className={styles.epCell}>
                      <span className={styles.epTitle}>{e.episodeTitle}</span>
                      {e.publishedAt && (
                        <time className={styles.epDate} dateTime={e.publishedAt.toISOString()}>
                          {e.publishedAt.toISOString().slice(0, 10)}
                        </time>
                      )}
                    </th>
                    <td className={styles.phrase}>&ldquo;{e.phrase}&rdquo;</td>
                    <td className={styles.real}>{e.context || "—"}</td>
                    <td className={e.status === "used" ? styles.real : styles.phantom}>
                      {STATUS_LABEL[e.status] ?? e.status}
                    </td>
                  </tr>
                ))}
              </tbody>
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
