import React, { useState, useEffect } from "react";
import { Header } from "@/components/dashboard/Header";
import { useAuth } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Receipt, Search, Play, Clock, CheckCircle2, XCircle, Download, FileText, Calendar, DollarSign, Building2, Eye, ChevronDown, Settings2, Filter, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface Invoice {
  id: string;
  email_id: string;
  email_subject: string;
  email_from: string;
  email_date: string;
  invoice_filename: string;
  invoice_storage_path: string;
  invoice_amount: number | null;
  vendor_name: string | null;
  confidence_score: number;
  status: string;
  created_at: string;
}

interface ScanJob {
  id: string;
  status: string;
  emails_scanned: number;
  invoices_found: number;
  date_from: string | null;
  date_to: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

const Invoices = () => {
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [jobs, setJobs] = useState<ScanJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [currentJob, setCurrentJob] = useState<ScanJob | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewScan, setShowNewScan] = useState(false);
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [invoiceUrl, setInvoiceUrl] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Scan configuration
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [senderFilter, setSenderFilter] = useState("");
  const [subjectKeywords, setSubjectKeywords] = useState("");
  const [filenameKeywords, setFilenameKeywords] = useState("invoice,bill,receipt,facture,rechnung");
  const [confidenceThreshold, setConfidenceThreshold] = useState([60]);
  const [maxEmails, setMaxEmails] = useState([100]);
  const [includeImages, setIncludeImages] = useState(true);
  const [includePdfs, setIncludePdfs] = useState(true);

  useEffect(() => {
    if (user) {
      fetchInvoices();
      fetchJobs();
    }
  }, [user]);

  // Poll for job updates when scanning
  useEffect(() => {
    if (!currentJob || currentJob.status === "completed" || currentJob.status === "failed") {
      return;
    }

    const interval = setInterval(async () => {
      await fetchJobs();
    }, 3000);

    return () => clearInterval(interval);
  }, [currentJob]);

  const fetchInvoices = async () => {
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await supabase.functions.invoke("invoice-scan", {
        body: { action: "invoices" },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (response.error) throw response.error;
      setInvoices(response.data.invoices || []);
    } catch (error) {
      console.error("Error fetching invoices:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchJobs = async () => {
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await supabase.functions.invoke("invoice-scan", {
        body: { action: "status" },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (response.error) throw response.error;
      const jobsList = response.data.jobs || [];
      setJobs(jobsList);

      // Update current job if exists
      if (currentJob) {
        const updated = jobsList.find((j: ScanJob) => j.id === currentJob.id);
        if (updated) {
          setCurrentJob(updated);
          if (updated.status === "completed") {
            setScanning(false);
            toast({
              title: "Scan Complete",
              description: `Found ${updated.invoices_found} invoices in ${updated.emails_scanned} emails`,
            });
            fetchInvoices();
          }
        }
      }
    } catch (error) {
      console.error("Error fetching jobs:", error);
    }
  };

  const startScan = async () => {
    setScanning(true);
    setShowNewScan(false);

    try {
      const { data: session } = await supabase.auth.getSession();
      
      // Create job with extended options
      const createResponse = await supabase.functions.invoke("invoice-scan", {
        body: { 
          action: "start",
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          senderFilter: senderFilter || undefined,
          subjectKeywords: subjectKeywords || undefined,
          filenameKeywords: filenameKeywords || undefined,
          confidenceThreshold: confidenceThreshold[0] / 100,
          maxEmails: maxEmails[0],
          includeImages,
          includePdfs,
        },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (createResponse.error) throw createResponse.error;
      
      const job = createResponse.data.job;
      setCurrentJob(job);

      // Start processing
      supabase.functions.invoke("invoice-scan", {
        body: { 
          action: "process", 
          jobId: job.id,
          senderFilter: senderFilter || undefined,
          subjectKeywords: subjectKeywords || undefined,
          filenameKeywords: filenameKeywords || undefined,
          confidenceThreshold: confidenceThreshold[0] / 100,
          maxEmails: maxEmails[0],
          includeImages,
          includePdfs,
        },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      }).catch(error => {
        console.error("Processing error:", error);
        setScanning(false);
        toast({
          title: "Scan Error",
          description: error.message || "Failed to process emails",
          variant: "destructive",
        });
      });

      toast({
        title: "Scan Started",
        description: "Scanning emails for invoices...",
      });
    } catch (error: any) {
      setScanning(false);
      toast({
        title: "Error",
        description: error.message || "Failed to start scan",
        variant: "destructive",
      });
    }
  };

  const viewInvoice = async (invoice: Invoice) => {
    try {
      const { data, error } = await supabase.storage
        .from("invoices")
        .createSignedUrl(invoice.invoice_storage_path, 3600); // 1 hour

      if (error) throw error;

      setInvoiceUrl(data.signedUrl);
      setViewingInvoice(invoice);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to load invoice",
        variant: "destructive",
      });
    }
  };

  const downloadInvoice = async (invoice: Invoice) => {
    try {
      const { data, error } = await supabase.storage
        .from("invoices")
        .download(invoice.invoice_storage_path);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = invoice.invoice_filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      toast({
        title: "Download Error",
        description: error.message || "Failed to download invoice",
        variant: "destructive",
      });
    }
  };

  const filteredInvoices = invoices.filter(invoice => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      invoice.invoice_filename.toLowerCase().includes(query) ||
      invoice.email_subject?.toLowerCase().includes(query) ||
      invoice.vendor_name?.toLowerCase().includes(query) ||
      invoice.email_from?.toLowerCase().includes(query)
    );
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4">
          <Header />
          <div className="py-8">
            <Skeleton className="h-96 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4">
        <Header />
        
        <div className="py-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Receipt className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Invoice Scanner</h1>
                <p className="text-muted-foreground">Automatically detect and save invoices from emails</p>
              </div>
            </div>
            
            <Dialog open={showNewScan} onOpenChange={setShowNewScan}>
              <DialogTrigger asChild>
                <Button disabled={scanning}>
                  <Play className="w-4 h-4 mr-2" />
                  New Scan
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Start Invoice Scan</DialogTitle>
                  <DialogDescription>
                    Configure how invoices will be detected in your emails
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-6 py-4">
                  {/* Date Range */}
                  <div className="space-y-3">
                    <Label className="text-sm font-medium">Date Range</Label>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="dateFrom" className="text-xs text-muted-foreground">From</Label>
                        <Input
                          id="dateFrom"
                          type="date"
                          value={dateFrom}
                          onChange={e => setDateFrom(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="dateTo" className="text-xs text-muted-foreground">To</Label>
                        <Input
                          id="dateTo"
                          type="date"
                          value={dateTo}
                          onChange={e => setDateTo(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Advanced Options */}
                  <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                    <CollapsibleTrigger asChild>
                      <Button variant="outline" className="w-full justify-between">
                        <span className="flex items-center gap-2">
                          <Settings2 className="w-4 h-4" />
                          Advanced Options
                        </span>
                        <ChevronDown className={`w-4 h-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-4 pt-4">
                      {/* Sender Filter */}
                      <div className="space-y-2">
                        <Label htmlFor="senderFilter">Sender Filter (optional)</Label>
                        <Input
                          id="senderFilter"
                          placeholder="e.g. @amazon.com, @stripe.com"
                          value={senderFilter}
                          onChange={e => setSenderFilter(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">Only scan emails from addresses containing these terms</p>
                      </div>

                      {/* Subject Keywords */}
                      <div className="space-y-2">
                        <Label htmlFor="subjectKeywords">Subject Keywords (optional)</Label>
                        <Input
                          id="subjectKeywords"
                          placeholder="e.g. invoice, payment, order"
                          value={subjectKeywords}
                          onChange={e => setSubjectKeywords(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">Only scan emails with subjects containing these words</p>
                      </div>

                      {/* Filename Keywords */}
                      <div className="space-y-2">
                        <Label htmlFor="filenameKeywords">Filename Keywords</Label>
                        <Textarea
                          id="filenameKeywords"
                          placeholder="invoice, bill, receipt"
                          value={filenameKeywords}
                          onChange={e => setFilenameKeywords(e.target.value)}
                          className="h-20"
                        />
                        <p className="text-xs text-muted-foreground">Comma-separated keywords to look for in attachment filenames</p>
                      </div>

                      {/* Confidence Threshold */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label>Confidence Threshold</Label>
                          <span className="text-sm font-medium">{confidenceThreshold[0]}%</span>
                        </div>
                        <Slider
                          value={confidenceThreshold}
                          onValueChange={setConfidenceThreshold}
                          min={20}
                          max={95}
                          step={5}
                        />
                        <p className="text-xs text-muted-foreground">Higher = fewer false positives, lower = more invoices found</p>
                      </div>

                      {/* Max Emails */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label>Max Emails to Scan</Label>
                          <span className="text-sm font-medium">{maxEmails[0]}</span>
                        </div>
                        <Slider
                          value={maxEmails}
                          onValueChange={setMaxEmails}
                          min={10}
                          max={500}
                          step={10}
                        />
                      </div>

                      {/* File Types */}
                      <div className="space-y-3">
                        <Label>File Types</Label>
                        <div className="flex items-center gap-6">
                          <div className="flex items-center gap-2">
                            <Switch id="includePdfs" checked={includePdfs} onCheckedChange={setIncludePdfs} />
                            <Label htmlFor="includePdfs" className="font-normal">PDFs</Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch id="includeImages" checked={includeImages} onCheckedChange={setIncludeImages} />
                            <Label htmlFor="includeImages" className="font-normal">Images</Label>
                          </div>
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  <Button onClick={startScan} className="w-full" size="lg">
                    <Play className="w-4 h-4 mr-2" />
                    Start Scanning
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {/* Current Scan Progress */}
          {scanning && currentJob && (
            <Card className="mb-6">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                  <div className="flex-1">
                    <p className="font-medium">Scanning emails...</p>
                    <p className="text-sm text-muted-foreground">
                      Scanned {currentJob.emails_scanned} emails, found {currentJob.invoices_found} invoices
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-12 gap-6">
            {/* Invoice List */}
            <div className="col-span-8">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle>Saved Invoices</CardTitle>
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Search invoices..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-64"
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <div className="space-y-4">
                      {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-20 w-full" />
                      ))}
                    </div>
                  ) : filteredInvoices.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <Receipt className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p>No invoices found</p>
                      <p className="text-sm">Start a scan to detect invoices in your emails</p>
                    </div>
                  ) : (
                    <ScrollArea className="h-[calc(100vh-400px)]">
                      <div className="space-y-3">
                        {filteredInvoices.map(invoice => (
                          <div
                            key={invoice.id}
                            className="flex items-start justify-between p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                          >
                            <div className="flex items-start gap-3">
                              <div className="p-2 rounded-lg bg-primary/10">
                                <FileText className="w-5 h-5 text-primary" />
                              </div>
                              <div>
                                <p className="font-medium">{invoice.invoice_filename}</p>
                                <p className="text-sm text-muted-foreground">
                                  {invoice.email_subject}
                                </p>
                                <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                                  {invoice.vendor_name && (
                                    <span className="flex items-center gap-1">
                                      <Building2 className="w-3 h-3" />
                                      {invoice.vendor_name}
                                    </span>
                                  )}
                                  {invoice.invoice_amount && (
                                    <span className="flex items-center gap-1">
                                      <DollarSign className="w-3 h-3" />
                                      {invoice.invoice_amount.toFixed(2)}
                                    </span>
                                  )}
                                  {invoice.email_date && (
                                    <span className="flex items-center gap-1">
                                      <Calendar className="w-3 h-3" />
                                      {format(new Date(invoice.email_date), "MMM d, yyyy")}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline">
                                {Math.round(invoice.confidence_score * 100)}% match
                              </Badge>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => viewInvoice(invoice)}
                                title="View invoice"
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => downloadInvoice(invoice)}
                                title="Download invoice"
                              >
                                <Download className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Scan History */}
            <div className="col-span-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Scan History</CardTitle>
                </CardHeader>
                <CardContent>
                  {jobs.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No scans yet
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {jobs.slice(0, 5).map(job => (
                        <div
                          key={job.id}
                          className="flex items-start gap-3 p-3 rounded-lg border"
                        >
                          {job.status === "completed" ? (
                            <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5" />
                          ) : job.status === "failed" ? (
                            <XCircle className="w-5 h-5 text-destructive mt-0.5" />
                          ) : (
                            <Clock className="w-5 h-5 text-muted-foreground mt-0.5" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">
                              {job.status === "completed"
                                ? `Found ${job.invoices_found} invoices`
                                : job.status === "processing"
                                ? "Scanning..."
                                : job.status}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {job.emails_scanned} emails scanned
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {format(new Date(job.created_at), "MMM d, yyyy h:mm a")}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>

      {/* Invoice Viewer Dialog */}
      <Dialog open={!!viewingInvoice} onOpenChange={(open) => !open && setViewingInvoice(null)}>
        <DialogContent className="max-w-4xl h-[90vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              <span className="truncate">{viewingInvoice?.invoice_filename}</span>
              <div className="flex items-center gap-2">
                {viewingInvoice && (
                  <Button variant="outline" size="sm" onClick={() => downloadInvoice(viewingInvoice)}>
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </Button>
                )}
              </div>
            </DialogTitle>
            {viewingInvoice && (
              <DialogDescription className="flex items-center gap-4 text-xs">
                {viewingInvoice.vendor_name && (
                  <span className="flex items-center gap-1">
                    <Building2 className="w-3 h-3" />
                    {viewingInvoice.vendor_name}
                  </span>
                )}
                {viewingInvoice.invoice_amount && (
                  <span className="flex items-center gap-1">
                    <DollarSign className="w-3 h-3" />
                    {viewingInvoice.invoice_amount.toFixed(2)}
                  </span>
                )}
                {viewingInvoice.email_date && (
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {format(new Date(viewingInvoice.email_date), "MMM d, yyyy")}
                  </span>
                )}
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="flex-1 overflow-hidden rounded-lg border bg-muted/50">
            {invoiceUrl ? (
              viewingInvoice?.invoice_filename.toLowerCase().endsWith('.pdf') ? (
                <iframe 
                  src={invoiceUrl} 
                  className="w-full h-full min-h-[60vh]"
                  title={viewingInvoice?.invoice_filename}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center p-4 overflow-auto">
                  <img 
                    src={invoiceUrl} 
                    alt={viewingInvoice?.invoice_filename}
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              )
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Invoices;
