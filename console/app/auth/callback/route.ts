import { type NextRequest, NextResponse } from 'next/server';
import { finishLogin } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const base = process.env.CONSOLE_URL ?? req.url;
  try {
    return NextResponse.redirect(new URL(await finishLogin(req.nextUrl.search), base));
  } catch (e) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'login failed', error: (e as Error).message }));
    return NextResponse.redirect(new URL('/auth/forbidden?reason=login', base));
  }
}
