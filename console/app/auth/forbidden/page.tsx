export default async function Forbidden({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return (
    <section className="panel" style={{ maxWidth: '36rem', margin: '3rem auto' }}>
      <div className="panel-head"><h2>{reason === 'login' ? 'Sign-in did not complete' : 'No access to the console'}</h2></div>
      <div className="panel-body">
        <p>{reason === 'login' ? 'The sign-in expired or was interrupted.' : 'Your account has no console role. Ask an admin for the viewer or operator role.'}</p>
        <p style={{ marginTop: '1rem' }}><a className="button" href="/auth/login">Sign in again</a></p>
      </div>
    </section>
  );
}
