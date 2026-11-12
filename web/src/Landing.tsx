import { useEffect, useRef, useState } from 'react';
import {
  AVAILABILITY_LABEL, BRAND, builtWithLine, CONNECTORS, CONSENT_TEXT, FAQ, groupFindings, HERO, PRIVACY, PROMISES, PROOF, STEPS, summaryLine,
  type FindingView,
} from './landingCopy';
import { checkSite, joinWaitingList, PREVIEW, type SiteReport } from './publicApi';
import './landing.css';

const CONTACT = (import.meta.env.VITE_CONTACT_EMAIL as string | undefined)?.trim() || undefined;

/** The page strangers see: check your site, see how it works, join the waiting list. Nothing here starts any work for anyone. */
export function Landing({ signInHref }: { signInHref: string }) {
  const [address, setAddress] = useState('');
  const [report, setReport] = useState<SiteReport>();
  const [state, setState] = useState<'idle' | 'checking'>('idle');
  const [problem, setProblem] = useState<string>();
  // Arriving from the sample inbox with #join: the form did not exist when the browser looked for it, so scroll once it does.
  useEffect(() => {
    if (window.location.hash === '#join') document.getElementById('join')?.scrollIntoView();
  }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim() || state === 'checking') return;
    setState('checking');
    setProblem(undefined);
    setReport(undefined);
    const out = await checkSite(address);
    setState('idle');
    if (out.ok) setReport(out.value);
    else setProblem(out.message);
  }

  return (
    <div className="lp" id="top">
      {PREVIEW && <div className="banner" role="status">Preview: the results here are samples. Nothing is sent or saved.</div>}
      <section className="lp-hero">
        <div className="lp-wrap">
          <header className="lp-top">
            <div className="brand"><span className="star" aria-hidden="true">✦</span> {BRAND}</div>
            <a className="lp-signin" href={signInHref}>Sign in</a>
          </header>
          <h1>{HERO.headline}</h1>
          <p className="lp-lead">{HERO.lead}</p>
          <form className="lp-check" onSubmit={run} noValidate>
            <label htmlFor="site">Your website address</label>
            <div className="lp-check-row">
              <input
                id="site"
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="url"
                placeholder="acme-plumbing.co.uk"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
              <button className="btn primary" disabled={state === 'checking' || !address.trim()}>{state === 'checking' ? HERO.working : HERO.button}</button>
            </div>
          </form>
          <div aria-live="polite">
            {problem && <p className="lp-problem" role="alert">{problem}</p>}
            {report && <Report report={report} />}
          </div>
        </div>
      </section>

      <main>
        <section className="lp-section" aria-labelledby="how">
          <div className="lp-wrap">
            <h2 id="how">How it works</h2>
            <ol className="lp-steps">
              {STEPS.map((s) => (
                <li key={s.title}>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="lp-section lp-tint" aria-labelledby="inbox">
          <div className="lp-wrap">
            <h2 id="inbox">You stay in charge</h2>
            <p>Every article arrives in an inbox you can open on your phone. Read it, edit it, then approve or reject it. Nothing reaches your site until you approve.</p>
            <div className="lp-mock" aria-hidden="true">
              <div className="lp-mock-title">A first article for your site</div>
              <div className="chip warn">Waiting for you</div>
              <div className="lp-mock-actions"><span>Edit</span><span>Reject</span><span className="on">Approve</span></div>
            </div>
            <p><a className="btn" href="#demo">Try the inbox with sample articles</a></p>
            <p className="muted small">The demo uses made-up articles. Nothing you do there is saved or published.</p>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="proof">
          <div className="lp-wrap">
            <h2 id="proof">We use it on our own site</h2>
            <p>The first article this service wrote went onto Plerosis&rsquo;s own website. A person edited and approved it before it was published.</p>
            <p><a href={PROOF.href} target="_blank" rel="noopener noreferrer">Read &ldquo;{PROOF.title}&rdquo;</a></p>
            <p className="muted small">One article is a small sample. It shows how the process works, not what results to expect.</p>
          </div>
        </section>

        <section className="lp-section lp-tint" aria-labelledby="promises">
          <div className="lp-wrap">
            <h2 id="promises">What we promise, and what we do not</h2>
            <dl className="lp-defs">
              {PROMISES.map((p) => (
                <div key={p.title}>
                  <dt>{p.title}</dt>
                  <dd>{p.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="sites">
          <div className="lp-wrap">
            <h2 id="sites">Which websites we can connect to</h2>
            <dl className="lp-defs lp-sites">
              {CONNECTORS.map((c) => (
                <div key={c.name}>
                  <dt>
                    {c.name} <span className={`chip ${c.availability === 'now' ? 'good' : c.availability === 'ask' ? '' : 'warn'}`}>{AVAILABILITY_LABEL[c.availability]}</span>
                  </dt>
                  <dd>{c.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="lp-section lp-tint" id="join" aria-labelledby="joinh">
          <div className="lp-wrap">
            <h2 id="joinh">Join the waiting list</h2>
            <p>We review each request ourselves. Until yours is ready, nothing is written or published for you, and you are not charged.</p>
            <JoinForm startAddress={address} />
          </div>
        </section>

        <section className="lp-section" aria-labelledby="faq">
          <div className="lp-wrap">
            <h2 id="faq">Questions</h2>
            <div className="lp-faq">
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section lp-tint" id="privacy" aria-labelledby="priv">
          <div className="lp-wrap">
            <h2 id="priv">Your details</h2>
            <ul className="lp-plain">
              {PRIVACY.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {CONTACT && <p>Questions about your details: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>}
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap">
          <p className="muted small">Made by Plerosis. {BRAND} is a working name.</p>
        </div>
      </footer>
    </div>
  );
}

const LEVEL_CHIP: Record<FindingView['level'], { label: string; cls: string }> = {
  fix: { label: 'Worth fixing', cls: 'bad' },
  info: { label: 'Worth a look', cls: 'warn' },
  good: { label: 'Looks fine', cls: 'good' },
};

function Report({ report }: { report: SiteReport }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus(), [report]);
  const g = groupFindings(report.findings);
  return (
    <article className="lp-report">
      <h2 tabIndex={-1} ref={head}>{builtWithLine(report.site, report.platform, report.platformName)}</h2>
      <p className="lp-summary">{summaryLine(report.summary)}</p>
      {(['fix', 'info'] as const).map((level) =>
        g[level].length ? (
          <ul key={level} className="lp-findings">
            {g[level].map((f) => (
              <li key={f.id}>
                <span className={`chip ${LEVEL_CHIP[level].cls}`}>{LEVEL_CHIP[level].label}</span>
                <strong>{f.title}</strong>
                <span className="muted">{f.detail}</span>
              </li>
            ))}
          </ul>
        ) : null,
      )}
      {g.good.length > 0 && (
        <details className="lp-fine">
          <summary>{g.good.length} {g.good.length === 1 ? 'thing looks' : 'things look'} fine</summary>
          <ul className="lp-findings">
            {g.good.map((f) => (
              <li key={f.id}>
                <span className="chip good">Looks fine</span>
                <strong>{f.title}</strong>
                <span className="muted">{f.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="lp-advice">
        <span className={`chip ${report.availability === 'now' ? 'good' : report.availability === 'ask' ? '' : 'warn'}`}>{AVAILABILITY_LABEL[report.availability]}</span>
        <p>{report.advice}</p>
      </div>
      <p className="muted small">{report.note}</p>
      <p><a className="btn primary" href="#join">Join the waiting list</a></p>
    </article>
  );
}

function JoinForm({ startAddress }: { startAddress: string }) {
  const [email, setEmail] = useState('');
  const [url, setUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [company, setCompany] = useState(''); // hidden from people; bots tend to fill it
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<string>();
  const shown = url || startAddress;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    setError(undefined);
    const out = await joinWaitingList({ email, url: shown, consent, company });
    if (out.ok) setState('done');
    else {
      setError(out.message);
      setState('idle');
    }
  }

  if (state === 'done') {
    return (
      <div className="lp-done" role="status">
        <h3>You are on the list</h3>
        <p>We will email <strong>{email.trim()}</strong> when your account is ready. Nothing is published for you and you are not charged.</p>
      </div>
    );
  }
  return (
    <form className="lp-join" onSubmit={send} noValidate>
      <label htmlFor="join-site">Your website address</label>
      <input id="join-site" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="url" placeholder="acme-plumbing.co.uk" value={shown} onChange={(e) => setUrl(e.target.value)} />
      <label htmlFor="join-email">Your email</label>
      <input id="join-email" type="email" inputMode="email" autoComplete="email" placeholder="you@acme-plumbing.co.uk" value={email} onChange={(e) => setEmail(e.target.value)} />
      <div className="lp-hp" aria-hidden="true">
        <label htmlFor="join-company">Company</label>
        <input id="join-company" type="text" tabIndex={-1} autoComplete="off" value={company} onChange={(e) => setCompany(e.target.value)} />
      </div>
      <label className="lp-consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{CONSENT_TEXT} <a href="#privacy">How we use your details</a></span>
      </label>
      <button className="btn primary" disabled={state === 'sending' || !email.trim() || !shown.trim() || !consent}>{state === 'sending' ? 'Joining…' : 'Join the waiting list'}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
