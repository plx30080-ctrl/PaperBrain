/**
 * auth.js — Supabase Auth wrapper for PaperBrain
 *
 * Exposes:
 *   Auth.init()             → set up session listener, returns initial session
 *   Auth.signUp(email, pw)  → { user, error }
 *   Auth.signIn(email, pw)  → { user, error }
 *   Auth.signOut()          → void
 *   Auth.getUser()          → user | null
 *   Auth.getToken()         → access_token string | null
 *   Auth.onAuthChange(fn)   → unsubscribe function
 *   Auth.client             → raw Supabase client (for DB calls in other modules)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const { supabaseUrl, supabaseAnonKey } = window.PAPERBRAIN_CONFIG ?? {};

if (!supabaseUrl || supabaseUrl === "YOUR_SUPABASE_URL") {
  console.warn(
    "[PaperBrain] Supabase not configured. Edit config.js with your project URL and anon key.",
  );
}

export const client = createClient(supabaseUrl ?? "", supabaseAnonKey ?? "");

let _session = null;
const _listeners = new Set();

function _notify(session) {
  _session = session;
  for (const fn of _listeners) fn(session?.user ?? null);
}

/** Call once at app start. Returns the initial user (or null). */
export async function init() {
  const { data: { session } } = await client.auth.getSession();
  _session = session;

  client.auth.onAuthStateChange((_event, session) => {
    _notify(session);
  });

  return session?.user ?? null;
}

/** Register a callback invoked whenever auth state changes. Returns unsubscribe fn. */
export function onAuthChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Returns the current Supabase User object, or null. */
export function getUser() {
  return _session?.user ?? null;
}

/** Returns the current JWT access token, or null. */
export function getToken() {
  return _session?.access_token ?? null;
}

/**
 * Sign up with email + password.
 * Returns { user, error } — error is a string message or null.
 */
export async function signUp(email, password) {
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) return { user: null, error: error.message };
  return { user: data.user, error: null };
}

/**
 * Sign in with email + password.
 * Returns { user, error }.
 */
export async function signIn(email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { user: null, error: error.message };
  _notify(data.session);
  return { user: data.user, error: null };
}

/** Sign out current user. */
export async function signOut() {
  await client.auth.signOut();
  _notify(null);
}

export default { client, init, onAuthChange, getUser, getToken, signUp, signIn, signOut };
