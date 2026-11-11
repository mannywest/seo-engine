import type { SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectApi, postManifest, type Candidate, type ConnectConfig, type Notice, type PendingPick } from './connectApi';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Business {
  clientId: string;
  name: string;
  role: 'owner' | 'reviewer';
}
interface Connection {
  clientId: string;
  status: 'connected' | 'needs_attention' | 'disconnected';
  label: string;
  contentDir?: string;
  lastProblem?: string;
}

type MemberRow = { client_id: string; role: string; clients: { name?: string } | { name?: string }[] | null };
type ConnectionRow = { client_id: string; status: string; label: string; settings: Record<string, unknown> | null; last_problem: string | null };

async function loadBusinesses(db: SupabaseClient): Promise<Business[]> {
  const { data, error } = await db.from('client_members').select('client_id, role, clients(name)');
  if (error) throw new Error(`Could not load your businesses: ${error.message}`);
  return ((data ?? []) as unknown as MemberRow[]).map((r) => {
    const c = Array.isArray(r.clients) ? r.clients[0] : r.clients;
    return { clientId: r.client_id, name: c?.name || r.client_id, role: r.role === 'owner' ? 'owner' : 'reviewer' };
  });
}

async function loadConnections(db: SupabaseClient): Promise<Record<string, Connection>> {
  const { data, error } = await db.from('site_connections').select('client_id, status, label, settings, last_problem');
  if (error) throw new Error(`Could not load your website connection: ${error.message}`);
  const out: Record<string, Connection> = {};
  for (const r of (data ?? []) as unknown as ConnectionRow[]) {
    const status = r.status === 'connected' || r.status === 'needs_attention' ? r.status : 'disconnected';
    const dir = r.settings?.contentDir;
    out[r.client_id] = { clientId: r.client_id, status, label: r.label, ...(typeof dir === 'string' ? { contentDir: dir } : {}), ...(r.last_problem ? { lastProblem: r.last_problem } : {}) };
  }
  return out;
}

/** The "Connect your website" screen. It shows inside the app's normal page; the app supplies the header. */
export function ConnectScreen({ db, notice, onBack }: { db: SupabaseClient; notice?: Notice; onBack: () => void }) {
  const api = useMemo(() => new ConnectApi(db), [db]);
  const [config, setConfig] = useState<ConnectConfig>();
  const [businesses, setBusinesses] = useState<Business[]>();
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string | undefined>(notice?.kind === 'app-created' ? 'The GitHub App is created. You can now connect a website.' : undefined);

  const load = useCallback(async () => {
    try {
      setError(undefined);
      const [cfg, biz, conns] = await Promise.all([api.config(), loadBusinesses(db), loadConnections(db)]);
      setConfig(cfg);
      setBusinesses(biz);
      setConnections(conns);
    } catch (e) {
      setError(message(e));
    }
  }, [api, db]);
  useEffect(() => void load(), [load]);

  const problem = notice?.kind === 'error' || notice?.kind === 'app-error' ? notice.text : undefined;

  return (
    <div className="review">
      <button className="link back" onClick={onBack}>← Back to inbox</button>
      <h1 className="title">Connect your website</h1>
      <p className="muted">Lodestar can add each article you approve to your website for you. You stay in control: nothing goes live until you say so.</p>

      {flash && <div className="flash" role="status">{flash}</div>}
      {problem && (
        <div className="card problem" role="alert">
          <p>{problem}</p>
        </div>
      )}
      {error && (
        <div className="card problem" role="alert">
          <p>{error}</p>
          <button className="btn" onClick={() => void load()}>Try again</button>
        </div>
      )}
      {!error && (!config || !businesses) && <p className="muted center">Loading…</p>}

      {config?.notConfigured && (
        <section className="card">
          <p>Connecting a website is not switched on yet. The inbox site is missing its server settings, so there is nothing to tap here until that is done.</p>
        </section>
      )}
      {config && config.admin && !config.ready && !config.notConfigured && <AppSetup api={api} />}
      {businesses && businesses.length === 0 && <p className="empty">You are not part of a business yet.</p>}
      {config &&
        businesses?.map((b) => (
          <BusinessCard
            key={b.clientId}
            business={b}
            connection={connections[b.clientId]}
            ready={config.ready}
            api={api}
            autoPick={notice?.kind === 'pick'}
            onChanged={() => void load()}
            onFlash={setFlash}
          />
        ))}
    </div>
  );
}

/** The one-time job: create the GitHub App. GitHub opens with everything filled in; the key goes straight into the vault, never past a person. */
function AppSetup({ api }: { api: ConnectApi }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function go() {
    setBusy(true);
    setError(undefined);
    try {
      const { action, manifest } = await api.prepareApp();
      postManifest(action, manifest);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>One-time set-up</h2>
      <p>Before anyone can connect a website, Lodestar needs its own GitHub App. It takes a few taps, and you only ever do it once.</p>
      <ol className="plain steps">
        <li>Tap the button. GitHub opens with everything filled in.</li>
        <li>On GitHub, tap <strong>Create GitHub App</strong>.</li>
        <li>You come straight back here. There is nothing to copy or paste: the app’s key goes directly into the secure vault.</li>
      </ol>
      <button className="btn primary" disabled={busy} onClick={() => void go()}>{busy ? 'Opening GitHub…' : 'Create the GitHub App'}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function StatusChip({ connection }: { connection?: Connection }) {
  if (connection?.status === 'connected') return <span className="chip good">Connected</span>;
  if (connection?.status === 'needs_attention') return <span className="chip warn">Needs a look</span>;
  return <span className="chip off">Not connected</span>;
}

function BusinessCard({
  business,
  connection,
  ready,
  api,
  autoPick,
  onChanged,
  onFlash,
}: {
  business: Business;
  connection?: Connection | undefined;
  ready: boolean;
  api: ConnectApi;
  autoPick: boolean;
  onChanged: () => void;
  onFlash: (text: string) => void;
}) {
  const owner = business.role === 'owner';
  const [pick, setPick] = useState<PendingPick | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmOff, setConfirmOff] = useState(false);
  const [other, setOther] = useState(false);

  // Back from GitHub: if there is a choice waiting for this business, show it straight away.
  useEffect(() => {
    if (!autoPick || !owner) return;
    let live = true;
    api
      .pending(business.clientId)
      .then((p) => live && setPick(p))
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [autoPick, owner, api, business.clientId]);

  async function connectGithub() {
    setBusy(true);
    setError(undefined);
    try {
      window.location.assign(await api.startGithub(business.clientId));
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(undefined);
    try {
      await api.disconnect(business.clientId);
      setConfirmOff(false);
      onFlash('Disconnected. New articles will wait in your inbox.');
      onChanged();
    } catch (e) {
      setError(message(e));
    }
    setBusy(false);
  }

  const connected = connection?.status === 'connected';
  return (
    <section className="card">
      <div className="between">
        <h2>{business.name}</h2>
        <StatusChip {...(connection ? { connection } : {})} />
      </div>

      {pick ? (
        <PickRepo
          api={api}
          clientId={business.clientId}
          pick={pick}
          onCancel={() => setPick(null)}
          onDone={(label) => {
            setPick(null);
            onFlash(`Connected to ${label}. Approved articles will now arrive there as a pull request for you to merge.`);
            onChanged();
          }}
        />
      ) : connected ? (
        <>
          <p>
            Approved articles are added to <strong>{connection.label}</strong>
            {connection.contentDir ? <> in the folder <code>{connection.contentDir}</code></> : null} as a pull request. Nothing goes live until you merge it on GitHub.
          </p>
          {owner && !confirmOff && (
            <div className="actions">
              <button className="btn" disabled={busy || !ready} onClick={() => void connectGithub()}>Change repository</button>
              <button className="btn danger-o" disabled={busy} onClick={() => setConfirmOff(true)}>Disconnect</button>
            </div>
          )}
          {owner && confirmOff && (
            <div className="confirm">
              <p><strong>Disconnect this website?</strong> New articles will wait in your inbox until you connect again.</p>
              <div className="actions">
                <button className="btn" disabled={busy} onClick={() => setConfirmOff(false)}>Not yet</button>
                <button className="btn danger" disabled={busy} onClick={() => void disconnect()}>{busy ? 'Saving…' : 'Yes, disconnect'}</button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {connection?.status === 'needs_attention' && <p className="error">{connection.lastProblem ?? 'The connection needs attention.'} Connect again to fix it.</p>}
          {connection?.status === 'disconnected' && <p className="muted">This website was disconnected.</p>}
          {!owner ? (
            <p className="muted">Only the owner of the business can connect the website.</p>
          ) : (
            <>
              <p>Where does your website live?</p>
              <ul className="plain opts">
                <li>
                  <button className="btn primary" disabled={busy || !ready} onClick={() => void connectGithub()}>{busy ? 'Opening GitHub…' : 'Connect GitHub'}</button>
                  <p className="small muted">
                    For sites kept on GitHub: Astro, Next.js, Hugo, Jekyll, GitHub Pages and similar. You choose exactly which repository Lodestar can touch.
                    {!ready && ' This opens once the one-time set-up is done.'}
                  </p>
                </li>
                {['WordPress', 'Wix', 'Shopify'].map((name) => (
                  <li key={name} className="soon">
                    <span>{name}</span>
                    <span className="chip off">Coming soon</span>
                  </li>
                ))}
                <li>
                  <button className="link" onClick={() => setOther((v) => !v)} aria-expanded={other}>My site is on something else</button>
                  {other && (
                    <p className="small">
                      No connection needed. When you approve an article, open it and tap <strong>Copy text</strong> or <strong>Download</strong>, then add it to your site yourself. This works for Squarespace, Webflow and anything else.
                    </p>
                  )}
                </li>
              </ul>
            </>
          )}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

const keyOf = (c: Candidate) => `${c.installationId}:${c.repo}`;

function PickRepo({ api, clientId, pick, onDone, onCancel }: { api: ConnectApi; clientId: string; pick: PendingPick; onDone: (label: string) => void; onCancel: () => void }) {
  const [chosen, setChosen] = useState<string | undefined>(pick.candidates.length === 1 ? keyOf(pick.candidates[0]!) : undefined);
  const [dir, setDir] = useState(pick.defaultContentDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const picked = pick.candidates.find((c) => keyOf(c) === chosen);

  async function save() {
    if (!picked) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.finish({ clientId, pickId: pick.pickId, installationId: picked.installationId, repo: picked.repo, contentDir: dir.trim() });
      onDone(r.label);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  return (
    <div>
      <h3>Which repository holds your website?</h3>
      <p className="small muted">These are the ones GitHub confirmed you can write to.</p>
      <ul className="plain pick">
        {pick.candidates.map((c) => (
          <li key={keyOf(c)}>
            <label className="opt">
              <input type="radio" name={`repo-${clientId}`} checked={chosen === keyOf(c)} onChange={() => setChosen(keyOf(c))} />
              <span>
                <strong>{c.repo}</strong>
                <span className="muted small"> · branch {c.defaultBranch}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <label htmlFor={`dir-${clientId}`} className="small muted">Folder for articles (leave it as it is if you are not sure)</label>
      <input id={`dir-${clientId}`} value={dir} onChange={(e) => setDir(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={120} />
      <p className="small muted">For each article you approve, Lodestar opens a pull request. It cannot merge it: you do that on GitHub.</p>
      <div className="actions">
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!picked || busy || !dir.trim()} onClick={() => void save()}>{busy ? 'Connecting…' : 'Connect'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
