import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { format } from 'date-fns';

export interface TranscriptionJob {
  id: string;
  status: string;
  files_processed: number | null;
  files_total: number | null;
  files_skipped: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
}

export const useTranscriptionJobs = () => {
  const { user } = useAuth();
  const [lastJob, setLastJob] = useState<TranscriptionJob | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchLastJob = useCallback(async () => {
    if (!user) {
      setLastJob(null);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("transcription_jobs")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') throw error;
      setLastJob(data || null);
    } catch (err) {
      console.error("Failed to fetch transcription jobs:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchLastJob();
  }, [fetchLastJob]);

  const getFormattedLastJob = () => {
    if (!lastJob?.completed_at) return "Never";
    return format(new Date(lastJob.completed_at), "MMM d, h:mm a");
  };

  const getTotalFilesTranscribed = () => {
    return lastJob?.files_processed || 0;
  };

  return {
    lastJob,
    loading,
    refetch: fetchLastJob,
    formattedLastJob: getFormattedLastJob(),
    totalFilesTranscribed: getTotalFilesTranscribed(),
  };
};
