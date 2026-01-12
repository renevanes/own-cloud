import React, { useState, useEffect } from "react";
import { Header } from "@/components/dashboard/Header";
import { useAuth } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Mail, Search, Inbox, Star, Send, FileText, Trash2, RefreshCw, Paperclip, Plus, User, MoreVertical, Unlink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { EmailViewer } from "@/components/gmail/EmailViewer";
import { format } from "date-fns";
import { GmailIcon, OutlookIcon } from "@/components/icons/CloudIcons";

interface ConnectedAccount {
  id: string;
  provider: string;
  account_email: string | null;
  account_name: string | null;
}

interface EmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  bodyPreview?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  payload?: {
    headers: { name: string; value: string }[];
    parts?: any[];
  };
  internalDate?: string;
}

interface Label {
  id: string;
  name: string;
  displayName?: string;
  type?: string;
}

const Email = () => {
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [emailAccounts, setEmailAccounts] = useState<ConnectedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [disconnectingAccount, setDisconnectingAccount] = useState<ConnectedAccount | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [selectedLabel, setSelectedLabel] = useState("INBOX");
  const [selectedMessage, setSelectedMessage] = useState<EmailMessage | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);

  const selectedAccount = emailAccounts.find(a => a.id === selectedAccountId);
  const isGmail = selectedAccount?.provider === "gmail";
  const isOutlook = selectedAccount?.provider === "outlook";

  useEffect(() => {
    if (user) {
      fetchEmailAccounts();
    }
  }, [user]);

  useEffect(() => {
    if (selectedAccountId) {
      setMessages([]);
      setLabels([]);
      setSelectedMessage(null);
      setSelectedLabel("INBOX");
      fetchLabels();
      fetchMessages();
    }
  }, [selectedAccountId]);

  useEffect(() => {
    if (selectedAccountId && selectedLabel) {
      fetchMessages();
    }
  }, [selectedLabel]);

  const fetchEmailAccounts = async () => {
    try {
      const { data: accounts } = await supabase
        .from("connected_accounts")
        .select("id, provider, account_email, account_name")
        .eq("user_id", user!.id)
        .in("provider", ["gmail", "outlook"]);

      setEmailAccounts(accounts || []);
      if (accounts && accounts.length > 0 && !selectedAccountId) {
        setSelectedAccountId(accounts[0].id);
      }
    } catch (error) {
      console.error("Error fetching email accounts:", error);
    } finally {
      setCheckingConnection(false);
    }
  };

  const fetchLabels = async () => {
    if (!selectedAccount) return;
    
    try {
      const { data: session } = await supabase.auth.getSession();
      const functionName = isGmail ? "gmail-browse" : "outlook-browse";
      const action = isGmail ? "labels" : "folders";
      
      const response = await supabase.functions.invoke(functionName, {
        body: { action, accountId: selectedAccountId },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (response.error) throw response.error;
      
      if (isGmail) {
        setLabels(response.data.labels || []);
      } else {
        // Map Outlook folders to label format
        const folders = response.data.folders || [];
        setLabels(folders.map((f: any) => ({
          id: f.id,
          name: f.displayName,
          displayName: f.displayName,
          type: f.isHidden ? "hidden" : "user"
        })));
      }
    } catch (error) {
      console.error("Error fetching labels/folders:", error);
    }
  };

  const fetchMessages = async (pageToken?: string) => {
    if (!selectedAccount) return;
    
    setLoading(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const functionName = isGmail ? "gmail-browse" : "outlook-browse";
      
      const body: any = { 
        action: "list", 
        accountId: selectedAccountId,
        query: searchQuery || undefined,
        pageToken
      };
      
      if (isGmail) {
        body.labelIds = [selectedLabel];
      } else {
        // Map common label names to Outlook folder IDs
        const folderMap: Record<string, string> = {
          "INBOX": "inbox",
          "SENT": "sentitems",
          "DRAFT": "drafts",
          "TRASH": "deleteditems",
          "STARRED": "inbox" // Outlook doesn't have starred, use inbox
        };
        body.folderId = folderMap[selectedLabel] || selectedLabel;
      }
      
      const response = await supabase.functions.invoke(functionName, {
        body,
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (response.error) throw response.error;
      
      const newMessages = response.data.messages || [];
      if (pageToken) {
        setMessages(prev => [...prev, ...newMessages]);
      } else {
        setMessages(newMessages);
      }
      setNextPageToken(response.data.nextPageToken);
    } catch (error: any) {
      console.error("Error fetching messages:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to fetch emails",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchMessages();
  };

  const handleConnect = async (provider: "google" | "microsoft") => {
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) {
        toast({ title: "Please sign in", variant: "destructive" });
        return;
      }

      const redirectUri = `${window.location.origin}/oauth/callback`;
      const service = provider === "google" ? "gmail" : "outlook";
      
      const response = await supabase.functions.invoke("oauth-connect", {
        body: {
          provider,
          redirectUri,
          permissionLevel: "read_only",
          service,
        },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });

      if (response.error) throw response.error;
      
      if (response.data?.authUrl) {
        sessionStorage.setItem("oauth_service", service);
        window.location.href = response.data.authUrl;
      }
    } catch (error: any) {
      console.error("Connect error:", error);
      toast({
        title: "Connection Error",
        description: error.message || "Failed to start connection",
        variant: "destructive",
      });
    }
  };

  const handleDisconnect = async () => {
    if (!disconnectingAccount) return;
    
    try {
      const { error } = await supabase
        .from("connected_accounts")
        .delete()
        .eq("id", disconnectingAccount.id);

      if (error) throw error;

      toast({
        title: "Account Disconnected",
        description: `${disconnectingAccount.account_email} has been disconnected`,
      });

      // Refresh accounts
      setEmailAccounts(prev => prev.filter(a => a.id !== disconnectingAccount.id));
      if (selectedAccountId === disconnectingAccount.id) {
        const remaining = emailAccounts.filter(a => a.id !== disconnectingAccount.id);
        setSelectedAccountId(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch (error: any) {
      console.error("Disconnect error:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to disconnect account",
        variant: "destructive",
      });
    } finally {
      setDisconnectingAccount(null);
    }
  };

  const getMessageSender = (message: EmailMessage): string => {
    if (isGmail && message.payload?.headers) {
      const from = message.payload.headers.find(h => h.name.toLowerCase() === "from");
      return from?.value?.split("<")[0].trim() || "";
    }
    return message.from?.emailAddress?.name || message.from?.emailAddress?.address || "";
  };

  const getMessageSubject = (message: EmailMessage): string => {
    if (isGmail && message.payload?.headers) {
      const subject = message.payload.headers.find(h => h.name.toLowerCase() === "subject");
      return subject?.value || "(no subject)";
    }
    return message.subject || "(no subject)";
  };

  const getMessageDate = (message: EmailMessage): string => {
    let date: Date;
    if (isGmail && message.internalDate) {
      date = new Date(parseInt(message.internalDate));
    } else if (message.receivedDateTime) {
      date = new Date(message.receivedDateTime);
    } else {
      return "";
    }
    
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
      return format(date, "h:mm a");
    }
    return format(date, "MMM d");
  };

  const getMessageSnippet = (message: EmailMessage): string => {
    return message.snippet || message.bodyPreview || "";
  };

  const hasAttachments = (message: EmailMessage): boolean => {
    if (isGmail) {
      return message.payload?.parts?.some(part => part.filename) || false;
    }
    return message.hasAttachments || false;
  };

  const isUnread = (message: EmailMessage): boolean => {
    if (isGmail) {
      return message.labelIds?.includes("UNREAD") || false;
    }
    return !message.isRead;
  };

  if (authLoading || checkingConnection) {
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

  // No accounts connected - show connect options
  if (emailAccounts.length === 0 || showConnectDialog) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4">
          <Header />
          <div className="py-8">
            {emailAccounts.length > 0 && (
              <Button 
                variant="ghost" 
                className="mb-4"
                onClick={() => setShowConnectDialog(false)}
              >
                ← Back to Email
              </Button>
            )}
            <div className="max-w-2xl mx-auto">
              <Card>
                <CardHeader className="text-center">
                  <div className="mx-auto p-4 rounded-full bg-primary/10 w-fit mb-4">
                    <Mail className="w-12 h-12 text-primary" />
                  </div>
                  <h2 className="text-2xl font-bold">Connect Your Email</h2>
                  <p className="text-muted-foreground">
                    Connect your Gmail or Outlook account to browse and manage your emails
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Button
                    onClick={() => handleConnect("google")}
                    variant="outline"
                    className="w-full h-14 justify-start gap-4"
                  >
                    <GmailIcon className="w-6 h-6" />
                    <div className="text-left">
                      <p className="font-medium">Connect Gmail</p>
                      <p className="text-xs text-muted-foreground">Google Workspace & personal accounts</p>
                    </div>
                  </Button>
                  <Button
                    onClick={() => handleConnect("microsoft")}
                    variant="outline"
                    className="w-full h-14 justify-start gap-4"
                  >
                    <OutlookIcon className="w-6 h-6" />
                    <div className="text-left">
                      <p className="font-medium">Connect Outlook</p>
                      <p className="text-xs text-muted-foreground">Microsoft 365 & personal accounts</p>
                    </div>
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const systemLabels = labels.filter(l => l.type === "system" || ["inbox", "sentitems", "drafts", "deleteditems"].includes(l.id?.toLowerCase() || ""));
  const userLabels = labels.filter(l => l.type === "user" && !["inbox", "sentitems", "drafts", "deleteditems"].includes(l.id?.toLowerCase() || ""));

  const labelIcons: Record<string, React.ReactNode> = {
    INBOX: <Inbox className="w-4 h-4" />,
    inbox: <Inbox className="w-4 h-4" />,
    STARRED: <Star className="w-4 h-4" />,
    SENT: <Send className="w-4 h-4" />,
    sentitems: <Send className="w-4 h-4" />,
    DRAFT: <FileText className="w-4 h-4" />,
    drafts: <FileText className="w-4 h-4" />,
    TRASH: <Trash2 className="w-4 h-4" />,
    deleteditems: <Trash2 className="w-4 h-4" />,
  };

  const defaultLabels = isGmail 
    ? ["INBOX", "STARRED", "SENT", "DRAFT", "TRASH"]
    : ["inbox", "sentitems", "drafts", "deleteditems"];

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4">
        <Header />
        
        <div className="py-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Mail className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Email</h1>
                <p className="text-muted-foreground">Manage your emails</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Account Selector with Disconnect */}
              <Select value={selectedAccountId || ""} onValueChange={setSelectedAccountId}>
                <SelectTrigger className="w-[280px]">
                  <SelectValue>
                    <div className="flex items-center gap-2">
                      {isGmail ? <GmailIcon className="w-4 h-4" /> : <OutlookIcon className="w-4 h-4" />}
                      <span className="truncate">{selectedAccount?.account_email || "Select account"}</span>
                    </div>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {emailAccounts.map(account => (
                    <SelectItem key={account.id} value={account.id}>
                      <div className="flex items-center gap-2">
                        {account.provider === "gmail" ? <GmailIcon className="w-4 h-4" /> : <OutlookIcon className="w-4 h-4" />}
                        <span>{account.account_email || account.account_name || "Email Account"}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon">
                    <MoreVertical className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setShowConnectDialog(true)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Add Account
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {selectedAccount && (
                    <DropdownMenuItem 
                      className="text-destructive"
                      onClick={() => setDisconnectingAccount(selectedAccount)}
                    >
                      <Unlink className="w-4 h-4 mr-2" />
                      Disconnect {selectedAccount.account_email}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              
              <Button variant="outline" onClick={() => fetchMessages()} disabled={loading}>
                <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-12 gap-6">
            {/* Sidebar */}
            <div className="col-span-3">
              <Card>
                <CardContent className="p-4">
                  <div className="space-y-1">
                    {defaultLabels.map(labelId => {
                      const label = labels.find(l => l.id === labelId || l.id?.toLowerCase() === labelId.toLowerCase());
                      const displayName = label?.name || label?.displayName || labelId;
                      return (
                        <Button
                          key={labelId}
                          variant={selectedLabel === labelId || selectedLabel.toLowerCase() === labelId.toLowerCase() ? "secondary" : "ghost"}
                          className="w-full justify-start"
                          onClick={() => setSelectedLabel(labelId)}
                        >
                          {labelIcons[labelId] || labelIcons[labelId.toLowerCase()]}
                          <span className="ml-2 capitalize">{displayName}</span>
                        </Button>
                      );
                    })}
                  </div>
                  
                  {userLabels.length > 0 && (
                    <>
                      <div className="my-4 border-t" />
                      <p className="text-xs font-medium text-muted-foreground mb-2">
                        {isGmail ? "Labels" : "Folders"}
                      </p>
                      <div className="space-y-1">
                        {userLabels.map(label => (
                          <Button
                            key={label.id}
                            variant={selectedLabel === label.id ? "secondary" : "ghost"}
                            className="w-full justify-start text-sm"
                            onClick={() => setSelectedLabel(label.id)}
                          >
                            {label.name || label.displayName}
                          </Button>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Email List */}
            <div className="col-span-4">
              <Card className="h-[calc(100vh-220px)]">
                <CardHeader className="pb-3">
                  <form onSubmit={handleSearch} className="flex gap-2">
                    <Input
                      placeholder="Search emails..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      className="flex-1"
                    />
                    <Button type="submit" size="icon" variant="outline">
                      <Search className="w-4 h-4" />
                    </Button>
                  </form>
                </CardHeader>
                <CardContent className="p-0">
                  <ScrollArea className="h-[calc(100vh-320px)]">
                    {loading && messages.length === 0 ? (
                      <div className="p-4 space-y-4">
                        {[...Array(5)].map((_, i) => (
                          <Skeleton key={i} className="h-16 w-full" />
                        ))}
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="p-8 text-center text-muted-foreground">
                        <Mail className="w-12 h-12 mx-auto mb-4 opacity-50" />
                        <p>No emails found</p>
                      </div>
                    ) : (
                      <div className="divide-y">
                        {messages.map(message => (
                          <button
                            key={message.id}
                            className={`w-full p-4 text-left hover:bg-muted/50 transition-colors ${
                              selectedMessage?.id === message.id ? "bg-muted" : ""
                            } ${isUnread(message) ? "font-semibold" : ""}`}
                            onClick={() => setSelectedMessage(message)}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-sm truncate flex-1">
                                {getMessageSender(message)}
                              </span>
                              <span className="text-xs text-muted-foreground whitespace-nowrap">
                                {getMessageDate(message)}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-sm truncate">
                                {getMessageSubject(message)}
                              </span>
                              {hasAttachments(message) && (
                                <Paperclip className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate mt-1">
                              {getMessageSnippet(message)}
                            </p>
                          </button>
                        ))}
                        {nextPageToken && (
                          <div className="p-4">
                            <Button
                              variant="outline"
                              className="w-full"
                              onClick={() => fetchMessages(nextPageToken)}
                              disabled={loading}
                            >
                              {loading ? "Loading..." : "Load More"}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>

            {/* Email Viewer */}
            <div className="col-span-5">
              <EmailViewer message={selectedMessage as any} />
            </div>
          </div>
        </div>
      </div>

      {/* Disconnect Confirmation Dialog */}
      <AlertDialog open={!!disconnectingAccount} onOpenChange={() => setDisconnectingAccount(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Email Account</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to disconnect {disconnectingAccount?.account_email}? 
              You can reconnect it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} className="bg-destructive text-destructive-foreground">
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Email;
