-- Create storage bucket for local files (private per user)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('user-files', 'user-files', false, 104857600, null)
ON CONFLICT (id) DO NOTHING;

-- Enable RLS on storage.objects
CREATE POLICY "Users can view their own files"
ON storage.objects
FOR SELECT
USING (bucket_id = 'user-files' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can upload their own files"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'user-files' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can update their own files"
ON storage.objects
FOR UPDATE
USING (bucket_id = 'user-files' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete their own files"
ON storage.objects
FOR DELETE
USING (bucket_id = 'user-files' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Add schedule column to sync_folders table for scheduled sync
ALTER TABLE public.sync_folders 
ADD COLUMN IF NOT EXISTS sync_schedule text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS next_sync_at timestamp with time zone DEFAULT NULL;

COMMENT ON COLUMN public.sync_folders.sync_schedule IS 'Cron-like schedule: hourly, daily, weekly, or null for manual';
COMMENT ON COLUMN public.sync_folders.next_sync_at IS 'When the next scheduled sync should run';