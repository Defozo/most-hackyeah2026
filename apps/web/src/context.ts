import { createContext, useContext } from 'react';
import type { Account, Entity, Outbox, Snapshot } from './types';
export interface AppContextValue { account: Account; snapshot: Snapshot; online: boolean; queue: Outbox[]; drafts: Entity[]; busy: boolean; view: string; navigate: (view: string) => void; run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>; command: (type: string, payload: Entity, dependencies?: string[]) => Promise<string | undefined>; refresh: () => Promise<void>; reloadLocal: () => Promise<void>; inform: (message: string, tone?: string) => void; canManage: boolean; canEdit: boolean; }
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() { const value = useContext(AppContext); if (!value) throw new Error('Missing app context'); return value; }

