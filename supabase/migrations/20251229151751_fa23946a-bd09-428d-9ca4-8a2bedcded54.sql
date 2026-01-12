-- Add unique constraint for user_id + provider combination to enable upsert
ALTER TABLE public.connected_accounts 
ADD CONSTRAINT connected_accounts_user_provider_unique 
UNIQUE (user_id, provider);