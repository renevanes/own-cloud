-- Add file_list column to cache the collected files between batch invocations
ALTER TABLE public.sync_jobs ADD COLUMN file_list jsonb DEFAULT NULL;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_user ON public.sync_jobs(user_id, status);