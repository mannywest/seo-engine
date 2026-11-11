import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectScreen } from './Connect';
import { readNotice } from './connectApi';
import { DemoSource, LiveSource, type InboxSource } from './data';
import { demoItems } from './demo';
import { articleFileName, articleMarkdown, canTakeAway } from './share';
import { itemsFor, parseBody, safeUrl, scoreTone, STATUS_LABEL, TABS, tabOf, timeAgo, wordCount, type Tab } from './text';
import type { InboxItem } from './types';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Problem({ title, text }: { title: string; text: string }) {
  return (
    <main className="shell">
      <div className="card problem" role="alert">
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </main>
  );
}

function Header({ right, demo }: { right?: React.ReactNode; demo?: boolean }) {
  return (
    <>
      {demo && (
        <div className="banner" role="status">
          Demo mode: sample articles, nothing is saved or published.
        </div>
      )}
      <header className="top">
        <div className="brand">
          <span className="star" aria-hidden="true">✦</span> Lodestar
        </div>
        {right}
      </header>
    </>
  );
}

/** The version people see before any account exists: sample articles held in memory. */
export function DemoApp() {
  const source = useMemo(() => new DemoSource(demoItems(), { delayMs: 250 }), []);
  return <Inbox source={source} />;
}

/** The real thing: sign in with an emailed link, then work the inbox as that person. */
export function LiveApp({ db }: { db: SupabaseClient }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    void db.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = db.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [db]);
  const source = useMemo(() => new LiveSource(db), [db]);
  // Back from GitHub the address says what happened (?connect=pick, ?connect=error&reason=...). Read it once, then tidy the address.
  const [notice] = useState(() => readNotice(window.location.search));
  const [view, setView] = useState<'inbox' | 'connect'>(notice ? 'connect' : 'inbox');
  useEffect(() => {
    if (notice) window.history.replaceState({}, '', window.location.pathname);
  }, [notice]);
  if (session === undefined) return <main className="shell"><Header /><p className="muted center">Loading…</p></main>;
  if (!session) return <SignIn db={db} />;
  const signOut = () => void db.auth.signOut();
  if (view === 'connect') {
    return (
      <main className="shell">
        <Header right={<div className="who"><button className="link" onClick={signOut}>Sign out</button></div>} />
        <ConnectScreen db={db} {...(notice ? { notice } : {})} onBack={() => setView('inbox')} />
      </main>
    );
  }
  return <Inbox source={source} email={session.user.email ?? ''} onSignOut={signOut} onOpenConnect={() => setView('connect')} />;
}

function SignIn({ db }: { db: SupabaseClient }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string>();
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    setError(undefined);
    const { error: err } = await db.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin } });
    if (err) {
      setError(err.message);
      setState('idle');
    } else setState('sent');
  }
  return (
    <main className="shell">
      <Header />
      <section className="card signin">
        <h1>Sign in</h1>
        {state === 'sent' ? (
          <p role="status">Check your email. We sent a link to <strong>{email.trim()}</strong>. Tap it on this phone to come back here, signed in.</p>
        ) : (
          <form onSubmit={send}>
            <p className="muted">No password. We email you a link.</p>
            <label htmlFor="email">Your email</label>
            <input id="email" type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn primary" disabled={state === 'sending' || !email.trim()}>{state === 'sending' ? 'Sending…' : 'Email me a link'}</button>
            {error && <p className="error" role="alert">{error}</p>}
          </form>
        )}
      </section>
    </main>
  );
}

function Inbox({ source, email, onSignOut, onOpenConnect }: { source: InboxSource; email?: string; onSignOut?: () => void; onOpenConnect?: () => void }) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('needs');
  const [openId, setOpenId] = useState<string>();
  const [flash, setFlash] = useState<string>();

  const load = useCallback(async () => {
    try {
      setError(undefined);
      setItems(await source.list());
    } catch (e) {
      setError(message(e));
    }
  }, [source]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(undefined), 7000);
    return () => clearTimeout(t);
  }, [flash]);

  const open = items?.find((i) => i.id === openId);
  const counts = (t: Tab) => (items ?? []).filter((i) => tabOf(i) === t).length;

  function decided(next: InboxItem, text: string) {
    setItems((cur) => cur?.map((i) => (i.id === next.id ? next : i)) ?? null);
    setOpenId(undefined);
    setFlash(text);
  }

  const right = (
    <div className="who">
      {email && <span className="muted small">{email}</span>}
      {onSignOut && <button className="link" onClick={onSignOut}>Sign out</button>}
    </div>
  );

  if (open) {
    return (
      <main className="shell">
        <Header demo={source.mode === 'demo'} right={right} />
        <Review key={open.id} item={open} source={source} onBack={() => setOpenId(undefined)} onDecided={decided} />
      </main>
    );
  }

  const shown = itemsFor(items ?? [], tab);
  return (
    <main className="shell">
      <Header demo={source.mode === 'demo'} right={right} />
      {flash && <div className="flash" role="status">{flash}</div>}
      {onOpenConnect && <button className="link" onClick={onOpenConnect}>Connect your website →</button>}
      <nav className="tabs" aria-label="Inbox sections">
        {TABS.map((t) => (
          <button key={t.id} className={t.id === tab ? 'tab on' : 'tab'} aria-pressed={t.id === tab} onClick={() => setTab(t.id)}>
            {t.label}
            {items && <span className="count">{counts(t.id)}</span>}
          </button>
        ))}
      </nav>
      {error && (
        <div className="card problem" role="alert">
          <p>{error}</p>
          <button className="btn" onClick={() => void load()}>Try again</button>
        </div>
      )}
      {!items && !error && <p className="muted center">Loading your articles…</p>}
      {items && shown.length === 0 && (
        <p className="empty">{tab === 'needs' ? 'Nothing is waiting for you. New articles appear here when they are ready.' : 'Nothing here yet.'}</p>
      )}
      <ul className="list">
        {shown.map((i) => (
          <li key={i.id}>
            <button className="row" onClick={() => setOpenId(i.id)}>
              <span className="row-title">{i.title}</span>
              <span className="row-meta">
                <span className={`chip ${scoreTone(i)}`}>{!i.quality.passed ? 'Needs a look' : i.quality.warnings.length ? 'Passed with notes' : 'Passed'} · {Math.round(i.quality.score)}</span>
                <span className="muted small">{timeAgo(i.decidedAt && tab !== 'needs' ? i.decidedAt : i.addedAt)}</span>
              </span>
              {tab === 'needs' && !i.quality.passed && <span className="row-reason">{i.reason}</span>}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

type Confirm = 'approve' | 'reject' | undefined;

function Review({ item, source, onBack, onDecided }: { item: InboxItem; source: InboxSource; onBack: () => void; onDecided: (next: InboxItem, text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.body);
  const [confirm, setConfirm] = useState<Confirm>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const waiting = item.status === 'waiting';

  async function copyText() {
    try {
      await navigator.clipboard.writeText(articleMarkdown(item));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Could not copy. Tap Download instead.');
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([articleMarkdown(item)], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = articleFileName(item);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const changed = editing && text !== item.body;

  async function run(kind: 'approve' | 'reject') {
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'approve') {
        const next = await source.approve(item, changed ? text : undefined);
        onDecided(next, `Approved: “${next.title}”. It will be published on the next run.`);
      } else {
        const next = await source.reject(item, note);
        onDecided(next, `Rejected: “${next.title}”. It will not be published.`);
      }
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  const q = item.quality;
  return (
    <>
      <div className="review">
        <button className="link back" onClick={onBack}>← Back to inbox</button>
        <h1 className="title">{item.title}</h1>
        <p className="muted">{item.description}</p>

        <section className={`card callout ${scoreTone(item)}`}>
          <div className="score">
            <span className="big">{Math.round(q.score)}</span>
            <span className="small">out of 100</span>
          </div>
          <div>
            <strong>{q.passed ? 'Passed the automatic checks' : 'Needs a look before you approve'}</strong>
            <p className="small">{item.reason}</p>
          </div>
        </section>

        {(q.issues.length > 0 || q.warnings.length > 0) && (
          <section className="card">
            <h2>Checks</h2>
            {q.issues.length > 0 && (
              <>
                <h3 className="bad-t">Problems</h3>
                <ul className="plain">{q.issues.map((x, n) => <li key={n}>{x}</li>)}</ul>
              </>
            )}
            {q.warnings.length > 0 && (
              <>
                <h3 className="warn-t">Worth a look</h3>
                <ul className="plain">{q.warnings.map((x, n) => <li key={n}>{x}</li>)}</ul>
              </>
            )}
          </section>
        )}

        <section className="card">
          <h2>Where the facts came from</h2>
          {item.sources.length === 0 ? (
            <p className="muted">No sources were recorded.</p>
          ) : (
            <ul className="plain">
              {item.sources.map((s, n) => {
                const href = safeUrl(s.url);
                return <li key={n}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a> : <span>{s.title || s.url}</span>}</li>;
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="between">
            <h2>Article</h2>
            <span className="muted small">{wordCount(editing ? text : item.body)} words</span>
          </div>
          {editing ? (
            <>
              <label htmlFor="body" className="small muted">Fix anything you need to. Your changes are not re-checked.</label>
              <textarea id="body" value={text} onChange={(e) => setText(e.target.value)} rows={18} />
            </>
          ) : (
            <div className="article">
              {parseBody(item.body).map((b, n) => {
                if ('items' in b) {
                  const li = b.items.map((x, m) => <li key={m}>{x}</li>);
                  return b.type === 'ul' ? <ul key={n}>{li}</ul> : <ol key={n}>{li}</ol>;
                }
                if (b.type === 'h2') return <h3 key={n}>{b.text}</h3>;
                if (b.type === 'h3') return <h4 key={n}>{b.text}</h4>;
                return <p key={n}>{b.text}</p>;
              })}
            </div>
          )}
        </section>

        {!waiting && (
          <section className="card">
            <h2>{STATUS_LABEL[item.status]}</h2>
            {item.decidedAt && <p className="small">{item.decidedBy ? `By ${item.decidedBy}, ` : ''}{timeAgo(item.decidedAt)}{item.edited ? ' · text corrected before approval' : ''}</p>}
            {item.note && <p className="small">Note: {item.note}</p>}
            {item.deliveryNote && <p className="small">{item.deliveryNote}</p>}
            {item.deliveredTo && (safeUrl(item.deliveredTo) ? <p className="small"><a href={safeUrl(item.deliveredTo)} target="_blank" rel="noopener noreferrer">View it live</a></p> : <p className="small">Delivered to {item.deliveredTo}</p>)}
          </section>
        )}
        {canTakeAway(item.status) && (
          <section className="card">
            <h2>Use it somewhere else</h2>
            <p className="small muted">If your website is not connected, or it is not on GitHub, copy the article or download it as a file and add it to your site yourself.</p>
            <div className="actions">
              <button className="btn" onClick={() => void copyText()}>{copied ? 'Copied ✓' : 'Copy text'}</button>
              <button className="btn" onClick={download}>Download</button>
            </div>
          </section>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      {waiting && (
        <div className="bar">
          {confirm === 'approve' && (
            <div className="confirm">
              <p><strong>Approve this article?</strong> {changed ? 'Your corrected text will be used. ' : ''}It will be published to the client’s site on the next run.</p>
              <div className="actions">
                <button className="btn" disabled={busy} onClick={() => setConfirm(undefined)}>Not yet</button>
                <button className="btn primary" disabled={busy} onClick={() => void run('approve')}>{busy ? 'Saving…' : 'Yes, approve'}</button>
              </div>
            </div>
          )}
          {confirm === 'reject' && (
            <div className="confirm">
              <p><strong>Reject this article?</strong> It will not be published.</p>
              <label htmlFor="note" className="small muted">Why? (optional)</label>
              <input id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
              <div className="actions">
                <button className="btn" disabled={busy} onClick={() => setConfirm(undefined)}>Not yet</button>
                <button className="btn danger" disabled={busy} onClick={() => void run('reject')}>{busy ? 'Saving…' : 'Yes, reject'}</button>
              </div>
            </div>
          )}
          {!confirm && (
            <div className="actions">
              <button className="btn danger-o" onClick={() => setConfirm('reject')}>Reject</button>
              {editing ? (
                <button className="btn" onClick={() => { setEditing(false); setText(item.body); }}>Cancel edit</button>
              ) : (
                <button className="btn" onClick={() => setEditing(true)}>Edit</button>
              )}
              <button className="btn primary" disabled={editing && !text.trim()} onClick={() => setConfirm('approve')}>{changed ? 'Approve with changes' : 'Approve'}</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
