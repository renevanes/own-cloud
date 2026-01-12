-- Create scanned_invoices table
CREATE TABLE public.scanned_invoices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  email_id TEXT NOT NULL,
  email_subject TEXT,
  email_from TEXT,
  email_date TIMESTAMP WITH TIME ZONE,
  invoice_filename TEXT NOT NULL,
  invoice_storage_path TEXT NOT NULL,
  invoice_amount NUMERIC,
  vendor_name TEXT,
  confidence_score NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create invoice_scan_jobs table
CREATE TABLE public.invoice_scan_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  emails_scanned INTEGER DEFAULT 0,
  invoices_found INTEGER DEFAULT 0,
  date_from TIMESTAMP WITH TIME ZONE,
  date_to TIMESTAMP WITH TIME ZONE,
  labels TEXT[],
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on both tables
ALTER TABLE public.scanned_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_scan_jobs ENABLE ROW LEVEL SECURITY;

-- RLS policies for scanned_invoices
CREATE POLICY "Users can view their own invoices" ON public.scanned_invoices FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own invoices" ON public.scanned_invoices FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own invoices" ON public.scanned_invoices FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own invoices" ON public.scanned_invoices FOR DELETE USING (auth.uid() = user_id);

-- RLS policies for invoice_scan_jobs
CREATE POLICY "Users can view their own scan jobs" ON public.invoice_scan_jobs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own scan jobs" ON public.invoice_scan_jobs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own scan jobs" ON public.invoice_scan_jobs FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own scan jobs" ON public.invoice_scan_jobs FOR DELETE USING (auth.uid() = user_id);

-- Create invoices storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('invoices', 'invoices', false);

-- Storage policies for invoices bucket
CREATE POLICY "Users can view their own invoices" ON storage.objects FOR SELECT USING (bucket_id = 'invoices' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can upload their own invoices" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'invoices' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can delete their own invoices" ON storage.objects FOR DELETE USING (bucket_id = 'invoices' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Add updated_at trigger for scanned_invoices
CREATE TRIGGER update_scanned_invoices_updated_at
BEFORE UPDATE ON public.scanned_invoices
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();