import React from "react";
import Link from "next/link";
import "./layout.css";
import { db } from "@/lib/db";
import { getRedisClient } from "@/lib/redis";
import { requireAdminPage } from "@/lib/adminAuth";
import SidebarNav from "./SidebarNav";

export const dynamic = "force-dynamic";

/** How long the header's infrastructure probes may take before the answer is
 *  simply "OFFLINE". Long enough for a healthy local/prod round-trip, short
 *  enough that a dead dependency can never hold up an operator's page. */
const REDIS_PROBE_TIMEOUT_MS = 1500;

/** Resolve to null if `p` hasn't settled within `ms` — never leave a hung
 *  dependency holding the render. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const bail = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, bail]).finally(() => clearTimeout(timer)) as Promise<T | null>;
}

async function checkInfrastructureStatus() {
  let dbConnected = false;
  let redisConnected = false;

  try {
    // Query database with a raw query to check connection status
    await withTimeout(db.$queryRaw`SELECT 1`, REDIS_PROBE_TIMEOUT_MS).then((r) => {
      if (r !== null) dbConnected = true;
    });
  } catch (e) {
    // Suppress console output
  }

  try {
    const redis = getRedisClient();
    // BOUND THIS PROBE. The shared client is built with
    // `maxRetriesPerRequest: null` because BullMQ requires it — which means a
    // command issued while Redis is unreachable is queued and retried FOREVER:
    // it never resolves and never rejects, so the catch below can't fire.
    // Unbounded, this status check hangs EVERY /admin render indefinitely
    // instead of reporting OFFLINE (invisible in prod, where Redis is up).
    // A probe that can't answer quickly IS the offline answer.
    const pong = await withTimeout(redis.ping(), REDIS_PROBE_TIMEOUT_MS);
    if (pong === "PONG") {
      redisConnected = true;
    }
  } catch (e) {
    // Suppress console output
  }

  return { dbConnected, redisConnected };
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Second line of defense behind proxy.ts — 404s non-admin requests even if
  // the proxy matcher ever stops covering this segment.
  await requireAdminPage();

  const { dbConnected, redisConnected } = await checkInfrastructureStatus();

  return (
    <div className="adminLayout">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark">T</span>
          <span className="brandText">
            Take Machine
            <span className="brandSub">Operator Console</span>
          </span>
        </div>
        <nav style={{ overflowY: "auto", flexGrow: 1, paddingRight: "0.25rem", margin: "1rem 0" }}>
          <SidebarNav />
        </nav>
      </aside>

      {/* Main View Container */}
      <div className="mainContainer">
        {/* Top Header Bar */}
        <header className="header">
          <div />
          <div className="headerStatus">
            {/* DB Connection Status */}
            <div className="statusIndicator" title={dbConnected ? "Database Connected" : "Database Offline"}>
              <span>Database:</span>
              <span className={`statusDot ${dbConnected ? "statusDotOnline" : "statusDotOffline"}`} />
              <span>{dbConnected ? "ONLINE" : "OFFLINE"}</span>
            </div>
            
            {/* Redis Connection Status */}
            <div className="statusIndicator" title={redisConnected ? "Redis Connected" : "Redis Offline"}>
              <span>Redis/Queue:</span>
              <span className={`statusDot ${redisConnected ? "statusDotOnline" : "statusDotOffline"}`} />
              <span>{redisConnected ? "ONLINE" : "OFFLINE"}</span>
            </div>
          </div>
        </header>

        {/* Content Frame */}
        <main className="content">
          {children}
        </main>
      </div>
    </div>
  );
}
