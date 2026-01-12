-- Drop the old constraint and add a new one that allows multiple accounts per provider
ALTER TABLE public.connected_accounts 
DROP CONSTRAINT IF EXISTS connected_accounts_user_id_provider_unique;

-- Add new unique constraint that includes account_email to allow multiple accounts per provider
ALTER TABLE public.connected_accounts 
ADD CONSTRAINT connected_accounts_user_provider_email_unique 
UNIQUE (user_id, provider, account_email);