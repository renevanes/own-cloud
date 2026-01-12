-- Enable realtime for sync progress
ALTER PUBLICATION supabase_realtime ADD TABLE public.sync_jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.sync_logs;