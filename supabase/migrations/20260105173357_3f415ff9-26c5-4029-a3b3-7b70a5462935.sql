-- Update the provider check constraint to include outlook
ALTER TABLE public.connected_accounts DROP CONSTRAINT IF EXISTS connected_accounts_provider_check;

ALTER TABLE public.connected_accounts ADD CONSTRAINT connected_accounts_provider_check 
CHECK (provider IN ('google', 'google_drive', 'microsoft', 'onedrive', 'gmail', 'outlook'));