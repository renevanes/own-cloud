-- Add sync_job_id to sync_logs for proper job-to-log relationship
ALTER TABLE public.sync_logs 
ADD COLUMN IF NOT EXISTS sync_job_id uuid REFERENCES public.sync_jobs(id);