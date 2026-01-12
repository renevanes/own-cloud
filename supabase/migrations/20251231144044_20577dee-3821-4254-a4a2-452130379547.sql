-- Add permission_level column to connected_accounts table
ALTER TABLE public.connected_accounts 
ADD COLUMN IF NOT EXISTS permission_level text DEFAULT 'read_write';

-- Add comment for documentation
COMMENT ON COLUMN public.connected_accounts.permission_level IS 'OAuth permission level: read_only or read_write';