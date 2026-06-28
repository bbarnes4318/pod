import React from "react";
import Link from "next/link";
import "./layout.css";
import { db } from "@/lib/db";
import { getRedisClient } from "@/lib/redis";

export const dynamic = "force-dynamic";

async function checkInfrastructureStatus() {
  let dbConnected = false;
  let redisConnected = false;

  try {
    // Query database with a raw query to check connection status
    await db.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (e) {
    // Suppress console output
  }

  try {
    const redis = getRedisClient();
    const pong = await redis.ping();
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
  const { dbConnected, redisConnected } = await checkInfrastructureStatus();

  return (
    <div className="adminLayout">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="brand">
          TAKE <span className="brandAccent">MACHINE</span>
        </div>
        <nav>
          <ul className="navLinks">
            <li className="navItem navActive">
              <Link href="/admin">Command Center</Link>
            </li>
            <li className="navItem">
              <Link href="/admin?tab=episodes">Episodes</Link>
            </li>
            <li className="navItem">
              <Link href="/admin/personalities">AI Hosts</Link>
            </li>
            <li className="navItem">
              <Link href="/admin?tab=settings">System Settings</Link>
            </li>
          </ul>
        </nav>
      </aside>

      {/* Main View Container */}
      <div className="mainContainer">
        {/* Top Header Bar */}
        <header className="header">
          <h1 className="headerTitle">Sports-Media Command Center</h1>
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
