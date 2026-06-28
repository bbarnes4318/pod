import { NextResponse } from "next/server";

export async function GET() {
  return new NextResponse("RSS feed not implemented yet.", {
    status: 501,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}
