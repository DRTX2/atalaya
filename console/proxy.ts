import { type NextRequest, NextResponse } from 'next/server';

// Deep links (an on-call page linking straight to an incident) survive sign-in: without a session
// cookie, go to the login with the path to come back to. This is only a coarse check; the session
// itself is verified on the server for every read and action (lib/auth.ts).
export function proxy(req: NextRequest) {
  if (!process.env.OIDC_ISSUER || req.cookies.has('atalaya_session')) return NextResponse.next();
  const login = new URL('/auth/login', process.env.CONSOLE_URL ?? req.url);
  login.searchParams.set('returnTo', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = { matcher: ['/((?!auth/|_next/|icon\\.svg|favicon\\.ico).*)'] };
