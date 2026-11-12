import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DemoApp, LiveApp, Problem } from './App';
import { Landing } from './Landing';
import { BRAND } from './landingCopy';
import { arrivingFromLink, wantsDemo } from './route';
import { isServiceKey } from './keys';
import './styles.css';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** The sample inbox, reached from the front page. Always says it is a demo and offers the way back and the way forward. */
function DemoPage() {
  return (
    <>
      <div className="lp-demo-bar" role="status">
        <span>Sample articles. Nothing here is saved or published.</span>
        <span className="lp-demo-links">
          <a href="#top">Back</a>
          <a href="#join">Join the waiting list</a>
        </span>
      </div>
      <DemoApp />
    </>
  );
}

/** Strangers get the front page; anyone signed in, or arriving from a sign-in or GitHub link, goes straight to the inbox. */
function Gate({ db }: { db: SupabaseClient }) {
  const [view, setView] = useState<'checking' | 'app' | 'public'>('checking');
  useEffect(() => {
    if (arrivingFromLink(window.location.search + window.location.hash)) return setView('app');
    let live = true;
    void db.auth.getSession().then(({ data }) => live && setView(data.session ? 'app' : 'public'));
    return () => {
      live = false;
    };
  }, [db]);
  if (view === 'checking') return <main className="shell"><p className="muted center">Loading…</p></main>;
  if (view === 'app') return <LiveApp db={db} />;
  return <Landing signInHref="/?signin=1" />;
}

function Root() {
  // Links inside the page change only the part after #, which does not reload it, so listen for that.
  const [here, setHere] = useState(window.location.search + window.location.hash);
  useEffect(() => {
    const on = () => setHere(window.location.search + window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (wantsDemo(here)) return <DemoPage />;
  if (url && key) {
    if (isServiceKey(key)) {
      return <Problem title="This app was set up with the wrong key" text="It was given the powerful service key instead of the public one. Nothing was loaded. Replace VITE_SUPABASE_ANON_KEY with the public (anon) key and publish again." />;
    }
    return <Gate db={createClient(url, key)} />;
  }
  return <Landing signInHref="/?demo=1" />;
}

document.title = `${BRAND}: fresh articles for your website, approved by you`;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
