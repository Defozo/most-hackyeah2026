import { useId, useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole, ShieldCheck, WifiOff } from 'lucide-react';
import { api, setCsrf } from './api';
import { Button, Field, Notice } from './ui';
import type { Entity } from './types';

export function Auth({ bootstrap, onLogin, initialError }: { bootstrap: boolean; onLogin: (data: Entity) => Promise<void>; initialError?: string }) {
  const [error, setError] = useState(initialError || ''); const [busy, setBusy] = useState(false);
  const usernameId = useId(); const usernameHelpId = `${usernameId}-help`;
  async function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); setBusy(true); setError(''); const form = new FormData(e.currentTarget); try {
    const result = await api(bootstrap ? '/api/auth/bootstrap' : '/api/auth/login', 'POST', Object.fromEntries(form)); setCsrf(result.csrfToken || ''); await onLogin(result);
  } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } }
  return <main className="auth-page"><section className="auth-brand"><a className="brand" href="/"><img src="/icon.svg" alt=""/><span>MOST<span>CIĄGŁOŚĆ USŁUG</span></span></a><div><span className="eyebrow">POMOC. ŁĄCZNOŚĆ. WODA.</span><h1>Utrzymaj usługi<br/>podczas awarii.</h1><p>Przydziel ludzi i sprzęt.<br/>Sprawdź, które usługi mogą działać.</p><div className="bridge-art" aria-hidden="true"><span/><span/><span/><i/></div></div><p className="auth-foot"><ShieldCheck size={16}/> Lokalna instalacja · niezależna od zewnętrznego SSO</p></section><section className="auth-form"><div className="auth-card"><span className="eyebrow">WITAJ W MOST</span><h2>{bootstrap ? 'Przygotuj swoją organizację' : 'Zaloguj się do centrum'}</h2><p>{bootstrap ? 'Pierwsze konto otrzyma rolę administratora. Ustal własne hasło.' : 'Użyj konta lokalnej organizacji.'}</p>{error && <Notice tone="red">{error}</Notice>}<form onSubmit={submit}>
    {bootstrap && <><Field label="Nazwa organizacji"><input name="organizationName" required defaultValue="Centrum demonstracyjne MOST" autoComplete="organization"/></Field><Field label="Imię i nazwisko lub nazwa dyżuru"><input name="displayName" required autoComplete="name"/></Field></>}
    <div className="field"><label htmlFor={usernameId}>Nazwa użytkownika</label><input id={usernameId} name="username" aria-describedby={usernameHelpId} autoComplete="username" autoFocus={!bootstrap} required minLength={3}/><small id={usernameHelpId}>Minimum 3 znaki.</small></div><Field label="Hasło" help={bootstrap ? 'Minimum 12 znaków. Hasło pozostaje w tej instalacji.' : undefined}><input name="password" type="password" required minLength={bootstrap ? 12 : 1} autoComplete={bootstrap ? 'new-password' : 'current-password'}/></Field><Button type="submit" kind="primary" disabled={busy}>{busy ? 'Łączenie…' : bootstrap ? 'Utwórz organizację' : 'Zaloguj się'}<ArrowRight size={18}/></Button></form><p className="auth-note"><LockKeyhole size={16}/> Dostęp offline wymaga wcześniej przygotowanego urządzenia i ważnego upoważnienia.</p><p className="muted"><WifiOff size={14}/> Pierwsze logowanie wymaga dostępu do serwera LAN.</p></div></section></main>;
}
