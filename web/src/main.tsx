import { createClient } from '@supabase/supabase-js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DemoApp, LiveApp, Problem } from './App';
import { isServiceKey } from './keys';
import './styles.css';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

function Root() {
  if (url && key) {
    if (isServiceKey(key)) {
      return <Problem title="This app was set up with the wrong key" text="It was given the powerful service key instead of the public one. Nothing was loaded. Replace VITE_SUPABASE_ANON_KEY with the public (anon) key and publish again." />;
    }
    return <LiveApp db={createClient(url, key)} />;
  }
  return <DemoApp />;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
