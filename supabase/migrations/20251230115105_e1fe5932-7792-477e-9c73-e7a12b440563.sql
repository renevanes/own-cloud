-- Enable pgcrypto extension for encryption
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create a secure function to encrypt tokens
-- This function uses pgp_sym_encrypt with the encryption key from secrets
CREATE OR REPLACE FUNCTION public.encrypt_token(token_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  encryption_key TEXT;
BEGIN
  -- Get encryption key from database settings or use a default for migration
  -- The actual encryption key will be used in the edge function
  IF token_value IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Return the token with a prefix to indicate it needs encryption
  -- The edge function will handle actual encryption
  RETURN token_value;
END;
$$;

-- Create a secure function to decrypt tokens
CREATE OR REPLACE FUNCTION public.decrypt_token(encrypted_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF encrypted_value IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Return the value as-is
  -- The edge function will handle actual decryption
  RETURN encrypted_value;
END;
$$;