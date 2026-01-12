-- Drop the existing check constraint and recreate it with 'local' included
ALTER TABLE public.sync_folders DROP CONSTRAINT IF EXISTS sync_folders_target_provider_check;
ALTER TABLE public.sync_folders ADD CONSTRAINT sync_folders_target_provider_check CHECK (target_provider IN ('google_drive', 'onedrive', 'local'));

-- Also update source_provider constraint if it exists
ALTER TABLE public.sync_folders DROP CONSTRAINT IF EXISTS sync_folders_source_provider_check;
ALTER TABLE public.sync_folders ADD CONSTRAINT sync_folders_source_provider_check CHECK (source_provider IN ('google_drive', 'onedrive', 'local'));