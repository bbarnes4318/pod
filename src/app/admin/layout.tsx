import React from "react";
import Link from "next/link";
import "./layout.css";
import { db } from "@/lib/db";
import { getRedisClient } from "@/lib/redis";
import SidebarNav from "./SidebarNav";

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
        <nav style={{ overflowY: "auto", flexGrow: 1, paddingRight: "0.25rem", margin: "1rem 0" }}>
          <SidebarNav />
        </nav>
      </aside>

      {/* Main View Container */}
      <div className="mainContainer">
        {/* Top Header Bar */}
        <header className="header">
          <div className="headerLogoContainer">
            <img src="/take-machine-logo.png" alt="Take Machine Logo" className="headerLogo" />
          </div>
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
