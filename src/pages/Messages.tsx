import { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/dashboard/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Search, MessageSquare } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ConversationList } from "@/components/messages/ConversationList";
import { ChatViewer } from "@/components/messages/ChatViewer";
import { ImportDialog } from "@/components/messages/ImportDialog";

interface Conversation {
  id: string;
  name: string;
  phone_number?: string;
  source_type: "whatsapp" | "sms";
  message_count: number;
  first_message_at?: string;
  last_message_at?: string;
  source_file: string;
}

interface Message {
  id: string;
  sender: string;
  content: string;
  message_type: "text" | "media" | "system";
  sent_at: string;
  is_outgoing: boolean;
}

export default function Messages() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState<string | null>(null);

  const fetchConversations = useCallback(async () => {
    if (!user) return;

    setIsLoadingConversations(true);
    try {
      const { data, error } = await supabase
        .from("chat_conversations")
        .select("*")
        .eq("user_id", user.id)
        .order("last_message_at", { ascending: false });

      if (error) throw error;
      setConversations((data as Conversation[]) || []);
    } catch (err) {
      console.error("Error fetching conversations:", err);
      toast({
        title: "Error",
        description: "Failed to load conversations",
        variant: "destructive",
      });
    } finally {
      setIsLoadingConversations(false);
    }
  }, [user, toast]);

  const fetchMessages = useCallback(async (conversationId: string) => {
    if (!user) return;

    setIsLoadingMessages(true);
    try {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .eq("user_id", user.id)
        .order("sent_at", { ascending: true });

      if (error) throw error;
      setMessages((data as Message[]) || []);
    } catch (err) {
      console.error("Error fetching messages:", err);
      toast({
        title: "Error",
        description: "Failed to load messages",
        variant: "destructive",
      });
    } finally {
      setIsLoadingMessages(false);
    }
  }, [user, toast]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  useEffect(() => {
    if (selectedConversation) {
      fetchMessages(selectedConversation.id);
    } else {
      setMessages([]);
    }
  }, [selectedConversation, fetchMessages]);

  const handleSelectConversation = (conv: Conversation) => {
    setSelectedConversation(conv);
  };

  const handleDeleteConversation = (id: string) => {
    setConversationToDelete(id);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!conversationToDelete || !user) return;

    try {
      const { error } = await supabase
        .from("chat_conversations")
        .delete()
        .eq("id", conversationToDelete)
        .eq("user_id", user.id);

      if (error) throw error;

      setConversations((prev) => prev.filter((c) => c.id !== conversationToDelete));
      if (selectedConversation?.id === conversationToDelete) {
        setSelectedConversation(null);
        setMessages([]);
      }

      toast({
        title: "Deleted",
        description: "Conversation deleted successfully",
      });
    } catch (err) {
      console.error("Error deleting conversation:", err);
      toast({
        title: "Error",
        description: "Failed to delete conversation",
        variant: "destructive",
      });
    } finally {
      setDeleteDialogOpen(false);
      setConversationToDelete(null);
    }
  };

  const filteredConversations = searchQuery
    ? conversations.filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.phone_number?.includes(searchQuery)
      )
    : conversations;

  if (!user) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 max-w-7xl">
          <Header />
          <div className="flex items-center justify-center h-[60vh]">
            <p className="text-muted-foreground">Please sign in to view messages</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 max-w-7xl">
        <Header />

        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <MessageSquare className="w-8 h-8 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Messages</h1>
              <p className="text-sm text-muted-foreground">
                Import and view chat messages from WhatsApp and SMS backups
              </p>
            </div>
          </div>
          <Button onClick={() => setImportDialogOpen(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Import Messages
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-220px)]">
          {/* Conversations List */}
          <div className="glass rounded-xl overflow-hidden flex flex-col">
            <div className="p-3 border-b">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search conversations..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <ConversationList
                conversations={filteredConversations}
                selectedId={selectedConversation?.id}
                onSelect={handleSelectConversation}
                onDelete={handleDeleteConversation}
                isLoading={isLoadingConversations}
              />
            </div>
          </div>

          {/* Chat Viewer */}
          <div className="lg:col-span-2 glass rounded-xl overflow-hidden">
            <ChatViewer
              conversationName={selectedConversation?.name || ""}
              messages={messages}
              isLoading={isLoadingMessages}
            />
          </div>
        </div>
      </div>

      <ImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        onImportComplete={fetchConversations}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Conversation</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this conversation and all its messages. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
