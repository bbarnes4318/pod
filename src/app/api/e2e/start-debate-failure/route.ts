import { NextResponse } from "next/server";
import { e2eEnabled, setForceStartDebateFailure } from "@/lib/e2eSeam";

// E2E-ONLY: arms/disarms the simulated startDebate failure. Returns 404 unless
// E2E_TEST_MODE=1 (set only on the dev server the Playwright harness spawns), so
// this route does not exist as far as any real deployment is concerned.
export async function POST(req: Request) {
  if (!e2eEnabled()) return new NextResponse("Not found", { status: 404 });
  let fail = false;
  try { fail = !!(await req.json())?.fail; } catch { /* default false */ }
  setForceStartDebateFailure(fail);
  return NextResponse.json({ ok: true, fail });
}
