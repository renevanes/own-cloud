import React, { useState, useEffect } from "react";
import { Header } from "@/components/dashboard/Header";
import { useAuth } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mail, Search, Inbox, Star, Send, FileText, Trash2, RefreshCw, Paperclip, Plus, User } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { GmailConnect } from "@/components/gmail/GmailConnect";
import { EmailViewer } from "@/components/gmail/EmailViewer";
import { format } from "date-fns";

interface ConnectedAccount {
  id: string;
  provider: string;
  account_email: string | null;
  account_name: string | null;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: { name: string; value: string }[];
    parts?: any[];
  };
  internalDate: string;
}

interface Label {
  id: string;
  name: string;
  type: string;
}

const Gmail = () => {
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [gmailAccounts, setGmailAccounts] = useState<ConnectedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [selectedLabel, setSelectedLabel] = useState("INBOX");
  const [selectedMessage, setSelectedMessage] = useState<GmailMessage | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      fetchGmailAccounts();
    }
  }, [user]);

  useEffect(() => {
    if (selectedAccountId) {
      fetchLabels();
      fetchMessages();
    }
  }, [selectedAccountId, selectedLabel]);

  const fetchGmailAccounts = async () => {
    try {
      const { data: accounts } = await supabase
        .from("connected_accounts")
        .select("id, provider, account_email, account_name")
        .eq("user_id", user!.id)
        .eq("provider", "gmail");

      setGmailAccounts(accounts || []);
      if (accounts && accounts.length > 0 && !selectedAccountId) {
        setSelectedAccountId(accounts[0].id);
      }
    } catch (error) {
      console.error("Error fetching Gmail accounts:", error);
    } finally {
      setCheckingConnection(false);
    }
  };

  const fetchLabels = async () => {
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await supabase.functions.invoke("gmail-browse", {
        body: { action: "labels", accountId: selectedAccountId },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (response.error) throw response.error;
      setLabels(response.data.labels || []);
    } catch (error) {
      console.error("Error fetching labels:", error);
    }
  };

  const fetchMessages = async (pageToken?: string) => {
    setLoading(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await supabase.functions.invoke("gmail-browse", {
        body: { 
          action: "list", 
          accountId: selectedAccountId,
          labelIds: [selectedLabel],
          query: searchQuery || undefined,
          pageToken
        },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (response.error) throw response.error;
      
      if (pageToken) {
        setMessages(prev => [...prev, ...(response.data.messages || [])]);
      } else {
        setMessages(response.data.messages || []);
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

  const getHeader = (message: GmailMessage, name: string): string => {
    const header = message.payload?.headers?.find(
      h => h.name.toLowerCase() === name.toLowerCase()
    );
    return header?.value || "";
  };

  const hasAttachments = (message: GmailMessage): boolean => {
    return message.payload?.parts?.some(part => part.filename) || false;
  };

  const formatDate = (internalDate: string): string => {
    const date = new Date(parseInt(internalDate));
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
      return format(date, "h:mm a");
    }
    return format(date, "MMM d");
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

  // Show connect dialog if no accounts or adding new account
  if (gmailAccounts.length === 0 || showAddAccount) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4">
          <Header />
          <div className="py-8">
            {gmailAccounts.length > 0 && (
              <Button 
                variant="ghost" 
                className="mb-4"
                onClick={() => setShowAddAccount(false)}
              >
                ← Back to Gmail
              </Button>
            )}
            <GmailConnect onConnected={() => {
              setShowAddAccount(false);
              fetchGmailAccounts();
            }} />
          </div>
        </div>
      </div>
    );
  }

  const selectedAccount = gmailAccounts.find(a => a.id === selectedAccountId);

  const systemLabels = labels.filter(l => l.type === "system");
  const userLabels = labels.filter(l => l.type === "user");

  const labelIcons: Record<string, React.ReactNode> = {
    INBOX: <Inbox className="w-4 h-4" />,
    STARRED: <Star className="w-4 h-4" />,
    SENT: <Send className="w-4 h-4" />,
    DRAFT: <FileText className="w-4 h-4" />,
    TRASH: <Trash2 className="w-4 h-4" />,
  };

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
                <h1 className="text-2xl font-bold">Gmail</h1>
                <p className="text-muted-foreground">Manage your emails</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Account Selector */}
              <Select value={selectedAccountId || ""} onValueChange={setSelectedAccountId}>
                <SelectTrigger className="w-[250px]">
                  <SelectValue>
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4" />
                      <span className="truncate">{selectedAccount?.account_email || "Select account"}</span>
                    </div>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {gmailAccounts.map(account => (
                    <SelectItem key={account.id} value={account.id}>
                      <div className="flex items-center gap-2">
                        <User className="w-4 h-4" />
                        <span>{account.account_email || account.account_name || "Gmail Account"}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={() => setShowAddAccount(true)}>
                <Plus className="w-4 h-4" />
              </Button>
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
                    {["INBOX", "STARRED", "SENT", "DRAFT", "TRASH"].map(labelId => {
                      const label = systemLabels.find(l => l.id === labelId);
                      if (!label) return null;
                      return (
                        <Button
                          key={labelId}
                          variant={selectedLabel === labelId ? "secondary" : "ghost"}
                          className="w-full justify-start"
                          onClick={() => setSelectedLabel(labelId)}
                        >
                          {labelIcons[labelId]}
                          <span className="ml-2">{label.name}</span>
                        </Button>
                      );
                    })}
                  </div>
                  
                  {userLabels.length > 0 && (
                    <>
                      <div className="my-4 border-t" />
                      <p className="text-xs font-medium text-muted-foreground mb-2">Labels</p>
                      <div className="space-y-1">
                        {userLabels.map(label => (
                          <Button
                            key={label.id}
                            variant={selectedLabel === label.id ? "secondary" : "ghost"}
                            className="w-full justify-start text-sm"
                            onClick={() => setSelectedLabel(label.id)}
                          >
                            {label.name}
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
                            } ${!message.labelIds?.includes("UNREAD") ? "" : "font-semibold"}`}
                            onClick={() => setSelectedMessage(message)}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-sm truncate flex-1">
                                {getHeader(message, "From").split("<")[0].trim()}
                              </span>
                              <span className="text-xs text-muted-foreground whitespace-nowrap">
                                {formatDate(message.internalDate)}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-sm truncate">
                                {getHeader(message, "Subject") || "(no subject)"}
                              </span>
                              {hasAttachments(message) && (
                                <Paperclip className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate mt-1">
                              {message.snippet}
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
              <EmailViewer message={selectedMessage} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Gmail;
