import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';

export interface OffsetRow {
  id?: number;
  user_id: string;
  offset_minutes: number;
  offset_state?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
  offset_value?: number | 'PENDING';
  created_at?: string;
}

export interface PendingDSDCandidate {
  eventType: 'UTILITY_ON' | 'UTILITY_OFF';
  tentativeDSD: number;
  createdAtIso: string;
}

interface UserOffsetContextValue {
  offset: OffsetRow | null;
  loading: boolean;
  pendingDSD: PendingDSDCandidate | null;
  updateOffset: (offsetMinutes: number) => Promise<void>;
  clearOffset: () => Promise<void>;
  setPendingDSDCandidate: (candidate: PendingDSDCandidate) => void;
  clearPendingDSD: () => void;
  confirmPendingDSD: () => Promise<void>;
  saveOffset: (offsetMinutes: number) => Promise<void>;
}

const UserOffsetContext = createContext<UserOffsetContextValue | null>(null);

export function UserOffsetProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [offset, setOffset] = useState<OffsetRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingDSD, setPendingDSD] = useState<PendingDSDCandidate | null>(null);

  // Fetch initial offset
  useEffect(() => {
    if (!user) { setOffset(null); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('user_offsets')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!cancelled && data) setOffset(data as OffsetRow);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  // Single realtime subscription for all consumers
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`user_offset_${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_offsets', filter: `user_id=eq.${user.id}` },
        payload => {
          if (payload.eventType === 'DELETE') {
            setOffset(null);
            return;
          }
          setOffset(payload.new as OffsetRow);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[UserOffsetProvider] Realtime channel subscribed');
        } else if (status === 'CHANNEL_ERROR') {
          console.error('[UserOffsetProvider] Realtime channel error');
        }
      });

    return () => { supabase.removeChannel(channel); };
  }, [user]);

  const updateOffset = useCallback(async (offsetMinutes: number) => {
    if (!user) return;
    const upsertData: any = {
      user_id: user.id,
      offset_minutes: offsetMinutes,
      updated_at: new Date().toISOString(),
    };
    const offsetState: string =
      offsetMinutes > 0 ? 'POSITIVE'
      : offsetMinutes < 0 ? 'NEGATIVE'
      : 'NEUTRAL';
    upsertData.offset_state = offsetState;
    upsertData.offset_value = offsetMinutes;

    const { data } = await supabase
      .from('user_offsets')
      .upsert(upsertData, { onConflict: 'user_id' })
      .select()
      .single();
    if (data) setOffset(data);
  }, [user]);

  const clearOffset = useCallback(async () => {
    if (!user) return;
    await supabase.from('user_offsets').delete().eq('user_id', user.id);
    setOffset(null);
  }, [user]);

  const setPendingDSDCandidate = useCallback((candidate: PendingDSDCandidate) => {
    setPendingDSD(candidate);
  }, []);

  const clearPendingDSD = useCallback(() => {
    setPendingDSD(null);
  }, []);

  const confirmPendingDSD = useCallback(async () => {
    if (!pendingDSD) return;
    await updateOffset(pendingDSD.tentativeDSD);
    setPendingDSD(null);
  }, [pendingDSD, updateOffset]);

  const saveOffset = updateOffset;

  return (
    <UserOffsetContext.Provider value={{
      offset,
      loading,
      pendingDSD,
      updateOffset,
      clearOffset,
      setPendingDSDCandidate,
      clearPendingDSD,
      confirmPendingDSD,
      saveOffset,
    }}>
      {children}
    </UserOffsetContext.Provider>
  );
}

export function useUserOffset(): UserOffsetContextValue {
  const context = useContext(UserOffsetContext);
  if (!context) {
    throw new Error('useUserOffset must be used within a UserOffsetProvider');
  }
  return context;
}