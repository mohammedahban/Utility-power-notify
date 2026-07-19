/**
 * useStateAnchor — Persistent, prediction-independent current-state tracker.
 *
 * Sources the utility state start time from:
 *   1. `inverter_state` real-time updates (Growatt live data)
 *   2. `power_events` (historical transitions) on mount
 *   3. AsyncStorage cache — survives app restarts so the timer never resets
 *
 * Completely decoupled from `utility_predictions` refreshes, so the
 * "elapsed" timer and slot start times never jump on DB re-analysis.
 */

import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';

const STORAGE_KEY = 'state_anchor_v1';

export interface StateAnchor {
  /** 'ON' | 'OFF' — current utility state */
  state: 'ON' | 'OFF';
  /** ISO string of when this state began */
  startIso: string;
}

/** Persist anchor to AsyncStorage silently */
async function persistAnchor(anchor: StateAnchor) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
  } catch (_) {}
}

/** Load cached anchor from AsyncStorage */
async function loadCachedAnchor(): Promise<StateAnchor | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StateAnchor;
    if (parsed.state && parsed.startIso) return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

export function useStateAnchor(): { anchor: StateAnchor | null } {
  const [anchor, setAnchor] = useState<StateAnchor | null>(null);
  // Track the last known utility_on boolean so we only update on genuine flips
  const lastUtilityOnRef = useRef<boolean | null>(null);

  const applyUtilityOn = (utilityOn: boolean, occurredAt: string) => {
    const newState: 'ON' | 'OFF' = utilityOn ? 'ON' : 'OFF';
    setAnchor(prev => {
      // Only update if the state has genuinely flipped
      if (prev && prev.state === newState) return prev;
      const next: StateAnchor = { state: newState, startIso: occurredAt };
      persistAnchor(next);
      return next;
    });
    lastUtilityOnRef.current = utilityOn;
  };

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // 1. Load cached anchor first so the timer is immediately available
      const cached = await loadCachedAnchor();
      if (!cancelled && cached) {
        setAnchor(cached);
        lastUtilityOnRef.current = cached.state === 'ON';
      }

      // 2. Fetch current inverter_state to get the ground truth
      const { data: inv } = await supabase
        .from('inverter_state')
        .select('utility_on, last_polled')
        .eq('id', 1)
        .maybeSingle();

      if (cancelled) return;

      if (inv && inv.utility_on !== null && inv.last_polled) {
        const currentUtilityOn = inv.utility_on as boolean;

        // Always look up the latest power_event matching the current state.
        // Previously, when the cached state matched the live state we'd trust
        // the cached startIso blindly — but if the app was closed for hours
        // while power cycled X→Y→X (back to the original state), the cached
        // startIso would be from the OLD cycle, making the home-screen
        // "elapsed" timer read many times the predicted duration.
        const eventType = currentUtilityOn ? 'UTILITY_ON' : 'UTILITY_OFF';
        const { data: events } = await supabase
          .from('power_events')
          .select('occurred_at, event_type')
          .eq('event_type', eventType)
          .order('occurred_at', { ascending: false })
          .limit(1);

        if (!cancelled) {
          const latestEventIso = events?.[0]?.occurred_at;
          // Use the event time only if it's newer than the cached anchor's
          // start — otherwise the cache is still the most accurate source
          // (e.g. we're in the same cycle as when we cached it).
          if (latestEventIso) {
            const eventMs = new Date(latestEventIso).getTime();
            const cachedMs = cached ? new Date(cached.startIso).getTime() : 0;
            if (!cached || eventMs > cachedMs) {
              applyUtilityOn(currentUtilityOn, latestEventIso);
            } else if (cached) {
              // Cache is at least as recent as the latest event for this
              // state — keep the cached startIso (more accurate).
              lastUtilityOnRef.current = currentUtilityOn;
              // Persist any state vs cache mismatch (e.g. cached was OFF,
              // live is ON, but no newer ON event found — edge case where
              // the live transition hasn't been written yet).
              if (cached.state !== (currentUtilityOn ? 'ON' : 'OFF')) {
                applyUtilityOn(currentUtilityOn, cached.startIso);
              }
            }
          } else if (!cached) {
            // No event and no cache — fall back to last_polled.
            applyUtilityOn(currentUtilityOn, inv.last_polled);
          } else {
            // No event found — trust the cached startIso if state matches,
            // otherwise fall back to inv.last_polled.
            if (cached.state === (currentUtilityOn ? 'ON' : 'OFF')) {
              lastUtilityOnRef.current = currentUtilityOn;
            } else {
              applyUtilityOn(currentUtilityOn, inv.last_polled);
            }
          }
        }
      }
    };

    init();

    // 4. Subscribe to real-time inverter_state changes
    const channel = supabase
      .channel(`state_anchor_live_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'inverter_state',
      }, async (payload) => {
        if (cancelled) return;
        const row = payload.new as any;
        if (row?.utility_on === null || row?.utility_on === undefined) return;
        const newUtilityOn = row.utility_on as boolean;

        // Flip detected — find the matching power_event for accurate start time
        if (lastUtilityOnRef.current !== newUtilityOn) {
          const eventType = newUtilityOn ? 'UTILITY_ON' : 'UTILITY_OFF';
          const { data: events } = await supabase
            .from('power_events')
            .select('occurred_at, event_type')
            .eq('event_type', eventType)
            .order('occurred_at', { ascending: false })
            .limit(1);

          const startIso = events?.[0]?.occurred_at ?? new Date().toISOString();
          if (!cancelled) applyUtilityOn(newUtilityOn, startIso);
        }
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return { anchor };
}
