import 'server-only';
import { jwtVerify, SignJWT } from 'jose';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import * as oidc from 'openid-client';
import { roleOf, safeReturnTo, type User } from './roles';

// OpenID Connect (Authorization Code + PKCE) against the platform's identity provider (Keycloak).
// The console is a confidential client: tokens stay on this server, the browser only gets a signed,
// httpOnly session cookie. Without OIDC_ISSUER the console runs read-only for a local "viewer".
const env = (name: string) => process.env[name] ?? '';
const ISSUER = env('OIDC_ISSUER'); // as the browser sees it, e.g. http://localhost:8180/realms/atalaya
const INTERNAL = env('OIDC_INTERNAL_URL'); // same server as this container reaches it, e.g. http://keycloak:8180
const CONSOLE_URL = env('CONSOLE_URL') || 'http://localhost:3100';
const SESSION = 'atalaya_session';
const LOGIN = 'atalaya_login';
const SESSION_HOURS = 8;

export const authEnabled = () => Boolean(ISSUER);

function secret() {
  const s = env('SESSION_SECRET');
  if (s.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters when OIDC is enabled');
  return new TextEncoder().encode(s);
}

let configuration: Promise<oidc.Configuration> | undefined;
function config() {
  configuration ??= oidc.discovery(new URL(ISSUER), env('OIDC_CLIENT_ID'), env('OIDC_CLIENT_SECRET'), undefined, {
    // The issuer is the browser-facing URL; server-to-server calls go to the internal address.
    [oidc.customFetch]: (url: string, options: oidc.CustomFetchOptions) => fetch(INTERNAL ? url.replace(new URL(ISSUER).origin, INTERNAL) : url, options as RequestInit),
    execute: ISSUER.startsWith('http://') ? [oidc.allowInsecureRequests] : [], // local development only
  }).catch((e) => {
    configuration = undefined; // retry discovery on the next request (the IdP may still be starting)
    throw e;
  });
  return configuration;
}

const cookieOptions = (maxAge: number) => ({ httpOnly: true, sameSite: 'lax' as const, secure: CONSOLE_URL.startsWith('https://'), path: '/', maxAge });
const sign = (claims: Record<string, unknown>, ttl: string) => new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(ttl).sign(secret());
const verify = async (token?: string) => (token ? (await jwtVerify(token, secret(), { algorithms: ['HS256'] }).catch(() => null))?.payload : null);

/** Starts a login: PKCE verifier, state and nonce live in a short signed cookie until the callback. */
export async function beginLogin(returnTo: unknown): Promise<string> {
  const c = await config();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  (await cookies()).set(LOGIN, await sign({ verifier, state, nonce, returnTo: safeReturnTo(returnTo) }, '10m'), cookieOptions(600));
  return oidc.buildAuthorizationUrl(c, {
    redirect_uri: `${CONSOLE_URL}/auth/callback`, scope: 'openid profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce,
  }).href;
}

/** Finishes a login: checks state, nonce and PKCE, then issues the session cookie. Returns where to go. */
export async function finishLogin(search: string): Promise<string> {
  const jar = await cookies();
  const pending = await verify(jar.get(LOGIN)?.value);
  jar.delete(LOGIN);
  if (!pending) throw new Error('login expired or was not started here');
  // Built from the public URL: the request URL inside the container is not the registered redirect URI.
  const tokens = await oidc.authorizationCodeGrant(await config(), new URL(`/auth/callback${search}`, CONSOLE_URL), {
    pkceCodeVerifier: pending.verifier as string, expectedState: pending.state as string, expectedNonce: pending.nonce as string, idTokenExpected: true,
  });
  const claims = tokens.claims()!;
  const role = roleOf(claims.roles);
  const user = { username: String(claims.preferred_username ?? claims.sub), name: String(claims.name ?? claims.preferred_username ?? claims.sub) };
  jar.set(SESSION, await sign({ sub: claims.sub, ...user, role, idToken: tokens.id_token }, `${SESSION_HOURS}h`), cookieOptions(SESSION_HOURS * 3600));
  return role ? (pending.returnTo as string) : '/auth/forbidden';
}

/** Ends the console session and returns the identity provider's logout URL (ends the SSO session too). */
export async function logout(): Promise<string> {
  const jar = await cookies();
  const session = await verify(jar.get(SESSION)?.value);
  jar.delete(SESSION);
  if (!authEnabled()) return '/';
  return oidc.buildEndSessionUrl(await config(), {
    post_logout_redirect_uri: `${CONSOLE_URL}/`, ...(session?.idToken ? { id_token_hint: session.idToken as string } : {}),
  }).href;
}

/** The signed-in user, or null. Without OIDC: a read-only local viewer. */
export async function currentUser(): Promise<User | null> {
  if (!authEnabled()) return { username: 'local', name: 'Local (no SSO)', role: 'viewer' };
  const s = await verify((await cookies()).get(SESSION)?.value);
  if (!s?.role) return null;
  return { username: s.username as string, name: s.name as string, role: s.role as User['role'] };
}

/** For pages and data reads: signed in with a console role, or off to the login. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect('/auth/login');
  return user;
}
