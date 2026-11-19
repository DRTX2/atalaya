import { NextResponse } from 'next/server';
import { logout } from '@/lib/auth';

// POST only: a logout link that any page could embed (GET) would let other sites sign people out.
export async function POST() {
  return NextResponse.redirect(new URL(await logout(), process.env.CONSOLE_URL ?? 'http://localhost:3100'), 303);
}
