-- Create connected_accounts table to store OAuth tokens
CREATE TABLE public.connected_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('onedrive', 'google_drive')),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMP WITH TIME ZONE,
  account_email TEXT,
  account_name TEXT,
  storage_used BIGINT DEFAULT 0,
  storage_total BIGINT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- Create sync_jobs table to track sync operations
CREATE TABLE public.sync_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  files_synced INTEGER DEFAULT 0,
  files_total INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create file_activity table for activity log
CREATE TABLE public.file_activity (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('synced', 'uploaded', 'modified', 'deleted')),
  source TEXT NOT NULL CHECK (source IN ('onedrive', 'google_drive')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_activity ENABLE ROW LEVEL SECURITY;

-- RLS Policies for connected_accounts
CREATE POLICY "Users can view their own connected accounts"
ON public.connected_accounts FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own connected accounts"
ON public.connected_accounts FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own connected accounts"
ON public.connected_accounts FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own connected accounts"
ON public.connected_accounts FOR DELETE USING (auth.uid() = user_id);

-- RLS Policies for sync_jobs
CREATE POLICY "Users can view their own sync jobs"
ON public.sync_jobs FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own sync jobs"
ON public.sync_jobs FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own sync jobs"
ON public.sync_jobs FOR UPDATE USING (auth.uid() = user_id);

-- RLS Policies for file_activity
CREATE POLICY "Users can view their own file activity"
ON public.file_activity FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own file activity"
ON public.file_activity FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Trigger for updated_at
CREATE TRIGGER update_connected_accounts_updated_at
BEFORE UPDATE ON public.connected_accounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();