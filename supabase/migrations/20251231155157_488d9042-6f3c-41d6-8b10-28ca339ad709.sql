-- Add 'cancelled' to the status check constraint
ALTER TABLE public.sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_status_check;
ALTER TABLE public.sync_jobs ADD CONSTRAINT sync_jobs_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'));

-- Add sync_folder_id column to link jobs to folders
ALTER TABLE public.sync_jobs ADD COLUMN IF NOT EXISTS sync_folder_id UUID REFERENCES public.sync_folders(id) ON DELETE SET NULL;