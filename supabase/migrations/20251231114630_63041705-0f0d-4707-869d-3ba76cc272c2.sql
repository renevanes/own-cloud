-- Create sync_logs table for tracking sync operations
CREATE TABLE public.sync_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sync_folder_id UUID REFERENCES public.sync_folders(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'started',
  action TEXT NOT NULL,
  source_file_name TEXT,
  source_file_id TEXT,
  target_file_name TEXT,
  target_file_id TEXT,
  file_size BIGINT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.sync_logs ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view their own sync logs"
ON public.sync_logs FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own sync logs"
ON public.sync_logs FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Index for faster queries
CREATE INDEX idx_sync_logs_user_created ON public.sync_logs(user_id, created_at DESC);
CREATE INDEX idx_sync_logs_sync_folder ON public.sync_logs(sync_folder_id);