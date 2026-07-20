import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { handlers } = await import("@/auth");
    return NextResponse.json({
      status: "ok",
      handlers: Object.keys(handlers),
    });
  } catch (e: any) {
    return NextResponse.json({
      status: "error",
      message: e.message,
      stack: e.stack?.split("\n").slice(0, 5),
    });
  }
}
