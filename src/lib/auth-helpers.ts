import { supabase } from "@/integrations/supabase/client";
import { Session } from "@supabase/supabase-js";

/**
 * Get a fresh session, refreshing if near expiry.
 * Returns null if session cannot be obtained or refreshed.
 */
export async function getFreshSession(): Promise<Session | null> {
  const { data: { session }, error } = await supabase.auth.getSession();
  
  if (error || !session) {
    console.log("getFreshSession: No session available");
    return null;
  }

  // Check if token expires within 2 minutes
  const expiresAt = session.expires_at;
  if (expiresAt) {
    const expiresAtMs = expiresAt * 1000;
    const twoMinutesFromNow = Date.now() + 2 * 60 * 1000;
    
    if (expiresAtMs < twoMinutesFromNow) {
      console.log("getFreshSession: Token near expiry, refreshing...");
      const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
      
      if (refreshError || !refreshed.session) {
        console.error("getFreshSession: Refresh failed", refreshError?.message);
        return null;
      }
      
      console.log("getFreshSession: Token refreshed successfully");
      return refreshed.session;
    }
  }

  return session;
}

/**
 * Verify the current session is valid by calling getUser.
 * Returns true if valid, false otherwise.
 */
export async function verifySession(session: Session): Promise<boolean> {
  const { error } = await supabase.auth.getUser(session.access_token);
  if (error) {
    console.error("verifySession: Token verification failed", error.message);
    return false;
  }
  return true;
}
