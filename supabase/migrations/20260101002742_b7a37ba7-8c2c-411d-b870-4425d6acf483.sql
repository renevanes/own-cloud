-- Create transcription_sources table for configured audio sources
CREATE TABLE public.transcription_sources (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'folder',
  scan_enabled BOOLEAN NOT NULL DEFAULT true,
  last_scanned_at TIMESTAMP WITH TIME ZONE,
  next_scan_at TIMESTAMP WITH TIME ZONE,
  scan_schedule TEXT DEFAULT 'manual',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider, folder_id)
);

-- Create transcription_jobs table
CREATE TABLE public.transcription_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  files_processed INTEGER DEFAULT 0,
  files_total INTEGER DEFAULT 0,
  files_skipped INTEGER DEFAULT 0,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create transcription_logs table
CREATE TABLE public.transcription_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  transcription_job_id UUID REFERENCES public.transcription_jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  source_provider TEXT NOT NULL,
  source_file_id TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  source_file_path TEXT,
  file_size BIGINT,
  duration_seconds NUMERIC,
  transcription_id TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS on all tables
ALTER TABLE public.transcription_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_logs ENABLE ROW LEVEL SECURITY;

-- RLS policies for transcription_sources
CREATE POLICY "Users can view their own transcription sources"
  ON public.transcription_sources FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own transcription sources"
  ON public.transcription_sources FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own transcription sources"
  ON public.transcription_sources FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own transcription sources"
  ON public.transcription_sources FOR DELETE
  USING (auth.uid() = user_id);

-- RLS policies for transcription_jobs
CREATE POLICY "Users can view their own transcription jobs"
  ON public.transcription_jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own transcription jobs"
  ON public.transcription_jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own transcription jobs"
  ON public.transcription_jobs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own transcription jobs"
  ON public.transcription_jobs FOR DELETE
  USING (auth.uid() = user_id);

-- RLS policies for transcription_logs
CREATE POLICY "Users can view their own transcription logs"
  ON public.transcription_logs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own transcription logs"
  ON public.transcription_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own transcription logs"
  ON public.transcription_logs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own transcription logs"
  ON public.transcription_logs FOR DELETE
  USING (auth.uid() = user_id);

-- Add triggers for updated_at
CREATE TRIGGER update_transcription_sources_updated_at
  BEFORE UPDATE ON public.transcription_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for job monitoring
ALTER PUBLICATION supabase_realtime ADD TABLE public.transcription_jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transcription_logs;