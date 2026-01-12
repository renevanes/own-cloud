-- Create sync_folders table to store folder sync preferences
CREATE TABLE public.sync_folders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  source_provider TEXT NOT NULL CHECK (source_provider IN ('onedrive', 'google_drive')),
  source_folder_id TEXT NOT NULL,
  source_folder_path TEXT NOT NULL,
  target_provider TEXT NOT NULL CHECK (target_provider IN ('onedrive', 'google_drive')),
  target_folder_id TEXT,
  target_folder_path TEXT,
  sync_enabled BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT different_providers CHECK (source_provider != target_provider)
);

-- Enable Row Level Security
ALTER TABLE public.sync_folders ENABLE ROW LEVEL SECURITY;

-- Create policies for user access
CREATE POLICY "Users can view their own sync folders" 
ON public.sync_folders 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own sync folders" 
ON public.sync_folders 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own sync folders" 
ON public.sync_folders 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own sync folders" 
ON public.sync_folders 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_sync_folders_updated_at
BEFORE UPDATE ON public.sync_folders
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();