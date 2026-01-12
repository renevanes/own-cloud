-- Add resume tracking to sync_jobs
ALTER TABLE public.sync_jobs 
ADD COLUMN IF NOT EXISTS resume_from_index integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS batch_size integer DEFAULT 50;