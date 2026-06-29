import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getRedisClient } from "@/lib/redis";
import { execSync } from "child_process";
import { getRequiredProductionEnvChecklist, validateProviderSelection } from "@/lib/services/productionEnvService";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: any[] = [];

  // 1. Database connection check
  try {
    await db.$queryRaw`SELECT 1`;
    checks.push({ name: "database", status: "pass", message: "Database connection successful." });
  } catch (e: any) {
    checks.push({ name: "database", status: "fail", message: `Database connection failed: ${e.message}` });
  }

  // 2. Redis connection check
  try {
    const redis = getRedisClient();
    const ping = await redis.ping();
    if (ping === "PONG") {
      checks.push({ name: "redis", status: "pass", message: "Redis queue connectivity online." });
    } else {
      checks.push({ name: "redis", status: "fail", message: `Redis ping returned unexpected response: ${ping}` });
    }
  } catch (e: any) {
    checks.push({ name: "redis", status: "fail", message: `Redis queue connection failed: ${e.message}` });
  }

  // 3. Environment checklist
  const envChecklist = getRequiredProductionEnvChecklist();
  const envFailures = envChecklist.filter((c) => c.status === "fail");
  const envWarnings = envChecklist.filter((c) => c.status === "warning");

  if (envFailures.length > 0) {
    checks.push({
      name: "environment_variables",
      status: "fail",
      message: `Missing or placeholder required production variables: ${envFailures.map((f) => f.key).join(", ")}`,
    });
  } else if (envWarnings.length > 0) {
    checks.push({
      name: "environment_variables",
      status: "warning",
      message: `Missing optional variables: ${envWarnings.map((w) => w.key).join(", ")}`,
    });
  } else {
    checks.push({ name: "environment_variables", status: "pass", message: "All required and optional variables are configured." });
  }

  // 4. Provider validation
  const providerVal = validateProviderSelection();
  if (!providerVal.valid) {
    checks.push({
      name: "provider_selection",
      status: "warning",
      message: providerVal.messages.join(" "),
    });
  } else {
    checks.push({ name: "provider_selection", status: "pass", message: "Production-ready provider settings selected." });
  }

  // 5. ffmpeg / ffprobe checks
  let ffmpegOk = false;
  try {
    execSync("ffmpeg -version", { timeout: 500, stdio: "ignore" });
    ffmpegOk = true;
  } catch (e) {}

  let ffprobeOk = false;
  try {
    execSync("ffprobe -version", { timeout: 500, stdio: "ignore" });
    ffprobeOk = true;
  } catch (e) {}

  checks.push({
    name: "ffmpeg",
    status: ffmpegOk ? "pass" : "warning",
    message: ffmpegOk ? "FFmpeg binary is available." : "FFmpeg is not available in system PATH.",
  });

  checks.push({
    name: "ffprobe",
    status: ffprobeOk ? "pass" : "warning",
    message: ffprobeOk ? "FFprobe binary is available." : "FFprobe is not available in system PATH.",
  });

  // 6. S3 config presence
  const storageProvider = process.env.STORAGE_PROVIDER || "local";
  if (storageProvider === "s3") {
    const s3Endpoint = process.env.S3_ENDPOINT;
    const s3Bucket = process.env.S3_BUCKET;
    if (!s3Endpoint || !s3Bucket) {
      checks.push({ name: "storage_config", status: "fail", message: "S3 storage provider selected but bucket/endpoint config is missing." });
    } else {
      checks.push({ name: "storage_config", status: "pass", message: `S3 storage config complete: bucket='${s3Bucket}'` });
    }
  } else {
    checks.push({ name: "storage_config", status: "warning", message: `Local storage configured. S3 recommended for production.` });
  }

  // 7. HTTPS/domain config check
  const isProduction = process.env.NODE_ENV === "production";
  const appBaseUrl = process.env.APP_BASE_URL || "";
  if (isProduction && !appBaseUrl.startsWith("https://")) {
    checks.push({ name: "https_domain", status: "fail", message: `APP_BASE_URL is not using HTTPS: '${appBaseUrl}'` });
  } else if (!appBaseUrl) {
    checks.push({ name: "https_domain", status: "fail", message: "APP_BASE_URL is missing." });
  } else {
    checks.push({ name: "https_domain", status: "pass", message: `HTTPS domain configured: '${appBaseUrl}'` });
  }

  const passed = !checks.some((c) => c.status === "fail");

  return NextResponse.json(
    {
      ready: passed,
      timestamp: new Date().toISOString(),
      checks,
    },
    {
      status: passed ? 200 : 503,
    }
  );
}
