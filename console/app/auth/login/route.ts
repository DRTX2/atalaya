import { type NextRequest, NextResponse } from 'next/server';
import { authEnabled, beginLogin } from '@/lib/auth';

export async function GET(req: NextRequest) {
  if (!authEnabled()) return NextResponse.redirect(new URL('/', process.env.CONSOLE_URL ?? req.url));
  return NextResponse.redirect(await beginLogin(req.nextUrl.searchParams.get('returnTo')));
}
