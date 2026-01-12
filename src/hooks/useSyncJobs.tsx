import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { format } from 'date-fns';

export interface SyncJob {
  id: string;
  status: string;
  files_synced: number | null;
  files_total: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
}

export const useSyncJobs = () => {
  const { user } = useAuth();
  const [lastSync, setLastSync] = useState<SyncJob | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchLastSync = useCallback(async () => {
    if (!user) {
      setLastSync(null);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("sync_jobs")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') throw error;
      setLastSync(data || null);
    } catch (err) {
      console.error("Failed to fetch sync jobs:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchLastSync();
  }, [fetchLastSync]);

  const getFormattedLastSync = () => {
    if (!lastSync?.completed_at) return "Never";
    return format(new Date(lastSync.completed_at), "MMM d, h:mm a");
  };

  const getTotalFilesSynced = () => {
    return lastSync?.files_synced || 0;
  };

  return {
    lastSync,
    loading,
    refetch: fetchLastSync,
    formattedLastSync: getFormattedLastSync(),
    totalFilesSynced: getTotalFilesSynced(),
  };
};
