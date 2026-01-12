-- Add unique constraint for user_id and provider combination to support upsert
ALTER TABLE public.connected_accounts 
ADD CONSTRAINT connected_accounts_user_id_provider_unique 
UNIQUE (user_id, provider);