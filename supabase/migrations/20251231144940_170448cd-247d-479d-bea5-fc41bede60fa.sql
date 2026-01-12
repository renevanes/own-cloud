-- Drop existing unique constraints that prevent multiple accounts of same provider
ALTER TABLE public.connected_accounts DROP CONSTRAINT IF EXISTS connected_accounts_user_id_provider_key;
ALTER TABLE public.connected_accounts DROP CONSTRAINT IF EXISTS connected_accounts_user_provider_unique;

-- Drop the provider check constraint to allow new providers
ALTER TABLE public.connected_accounts DROP CONSTRAINT IF EXISTS connected_accounts_provider_check;

-- Add account_id column to uniquely identify each account
ALTER TABLE public.connected_accounts 
ADD COLUMN IF NOT EXISTS account_id text;

-- Add provider check that includes aws_s3
ALTER TABLE public.connected_accounts 
ADD CONSTRAINT connected_accounts_provider_check 
CHECK (provider = ANY (ARRAY['onedrive'::text, 'google_drive'::text, 'aws_s3'::text]));

-- Create unique constraint on user_id + provider + account_id (allows multiple accounts per provider)
CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_user_provider_account_unique 
ON public.connected_accounts (user_id, provider, COALESCE(account_id, id::text));

-- Update sync_folders to reference specific account instead of just provider
ALTER TABLE public.sync_folders 
ADD COLUMN IF NOT EXISTS source_account_id uuid REFERENCES public.connected_accounts(id);

ALTER TABLE public.sync_folders 
ADD COLUMN IF NOT EXISTS target_account_id uuid REFERENCES public.connected_accounts(id);