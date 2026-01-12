import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useAIConversations, AIMessage } from "@/hooks/useAIConversations";
import { Send, Sparkles, Loader2, AlertCircle, User, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Header } from "@/components/dashboard/Header";
import { ConversationSidebar } from "@/components/ai/ConversationSidebar";
import { FileUploadButton } from "@/components/ai/FileUploadButton";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";

interface UploadedFile {
  name: string;
  type: string;
  content: string;
}

const AIChat: React.FC = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const {
    conversations,
    currentConversation,
    messages,
    loading: conversationsLoading,
    createConversation,
    selectConversation,
    updateConversationTitle,
    deleteConversation,
    addMessage,
    setMessages,
    setCurrentConversation,
  } = useAIConversations();
  
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input on load
  useEffect(() => {
    inputRef.current?.focus();
  }, [currentConversation]);

  const sendMessage = async (userMessage: string) => {
    if (!userMessage.trim() || isLoading || !user) return;

    setInput('');
    setIsLoading(true);
    setError(null);

    // Create conversation if needed
    let conversationId = currentConversation?.id;
    if (!conversationId) {
      const newConv = await createConversation(
        userMessage.slice(0, 50) + (userMessage.length > 50 ? "..." : "")
      );
      if (!newConv) {
        setError("Failed to create conversation");
        setIsLoading(false);
        return;
      }
      conversationId = newConv.id;
    }

    // Add user message to DB
    const userMsg = await addMessage(
      conversationId,
      'user',
      userMessage.trim(),
      uploadedFile ? {
        fileName: uploadedFile.name,
        fileType: uploadedFile.type,
        fileContent: uploadedFile.content,
      } : undefined
    );

    if (!userMsg) {
      setError("Failed to save message");
      setIsLoading(false);
      return;
    }

    // Add to local state
    setMessages(prev => [...prev, userMsg]);

    // Build context for AI
    const fileContext = uploadedFile ? {
      content: uploadedFile.content,
      fileName: uploadedFile.name,
      fileType: uploadedFile.type,
    } : undefined;

    // Clear uploaded file after sending
    setUploadedFile(null);

    let assistantContent = '';
    const assistantId = crypto.randomUUID();

    // Add placeholder assistant message
    const placeholderAssistant: AIMessage = {
      id: assistantId,
      conversation_id: conversationId,
      role: 'assistant',
      content: '',
      file_name: null,
      file_type: null,
      file_content: null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, placeholderAssistant]);

    try {
      // Get the user's session for authenticated requests
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('You must be logged in to use AI chat');
      }

      // Build messages for API
      const apiMessages = [...messages, userMsg].map(m => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            messages: apiMessages,
            fileContext,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Request failed with status ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        textBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf('\n')) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.startsWith(':') || line.trim() === '') continue;
          if (!line.startsWith('data: ')) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId ? { ...m, content: assistantContent } : m
                )
              );
            }
          } catch {
            textBuffer = line + '\n' + textBuffer;
            break;
          }
        }
      }

      // Final flush
      if (textBuffer.trim()) {
        for (let raw of textBuffer.split('\n')) {
          if (!raw) continue;
          if (raw.endsWith('\r')) raw = raw.slice(0, -1);
          if (raw.startsWith(':') || raw.trim() === '') continue;
          if (!raw.startsWith('data: ')) continue;
          const jsonStr = raw.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId ? { ...m, content: assistantContent } : m
                )
              );
            }
          } catch {
            // ignore
          }
        }
      }

      // Save assistant message to DB
      if (assistantContent) {
        await addMessage(conversationId, 'assistant', assistantContent);
        
        // Update title if this is the first exchange
        if (messages.length === 0) {
          // Generate a title from the first response
          const title = assistantContent.slice(0, 50).replace(/\n/g, ' ') + 
            (assistantContent.length > 50 ? "..." : "");
          await updateConversationTitle(conversationId, title);
        }
      }
    } catch (err) {
      console.error('AI chat error:', err);
      setError(err instanceof Error ? err.message : 'Failed to get response');
      // Remove placeholder if no content
      if (!assistantContent) {
        setMessages(prev => prev.filter(m => m.id !== assistantId));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleNewConversation = async () => {
    setCurrentConversation(null);
    setMessages([]);
    setSidebarOpen(false);
    inputRef.current?.focus();
  };

  const handleSelectConversation = async (conv: typeof conversations[0]) => {
    await selectConversation(conv);
    setSidebarOpen(false);
  };

  const suggestedPrompts = [
    "What can you help me with?",
    "Explain how cloud storage works",
    "Give me productivity tips",
    "How do I organize my files better?",
  ];

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const SidebarContent = (
    <ConversationSidebar
      conversations={conversations}
      currentConversation={currentConversation}
      loading={conversationsLoading}
      onSelectConversation={handleSelectConversation}
      onNewConversation={handleNewConversation}
      onDeleteConversation={deleteConversation}
    />
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Background Effects */}
      <div className="fixed inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />
      <div className="fixed top-0 right-0 w-96 h-96 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 left-0 w-96 h-96 bg-accent/10 rounded-full blur-3xl pointer-events-none" />
      
      <div className="relative container mx-auto px-4">
        <Header />
        
        <div className="max-w-6xl mx-auto pb-8">
          <Card className="h-[calc(100vh-200px)] flex overflow-hidden">
            {/* Desktop Sidebar */}
            <div className="hidden md:flex">
              {SidebarContent}
            </div>

            {/* Main Chat Area */}
            <div className="flex-1 flex flex-col">
              {/* Chat Header */}
              <div className="px-4 md:px-6 py-4 border-b flex items-center gap-3 shrink-0">
                {/* Mobile menu button */}
                <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
                  <SheetTrigger asChild>
                    <Button variant="ghost" size="icon" className="md:hidden">
                      <Menu className="w-5 h-5" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="p-0 w-64">
                    {SidebarContent}
                  </SheetContent>
                </Sheet>

                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold truncate">
                    {currentConversation?.title || "New Conversation"}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {uploadedFile ? `File attached: ${uploadedFile.name}` : "Ask me anything"}
                  </p>
                </div>
              </div>

              {/* Messages Area */}
              <ScrollArea className="flex-1 px-4 md:px-6" ref={scrollRef}>
                <div className="py-6 space-y-4">
                  {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-violet-500/20 to-purple-600/20 flex items-center justify-center mb-4">
                        <Sparkles className="w-8 h-8 text-violet-500" />
                      </div>
                      <h3 className="text-lg font-medium mb-2">How can I help you today?</h3>
                      <p className="text-sm text-muted-foreground mb-6 max-w-md">
                        I'm your AI assistant. Ask me questions, upload files to analyze, or just have a conversation.
                      </p>
                      <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                        {suggestedPrompts.map((prompt, i) => (
                          <button
                            key={i}
                            onClick={() => sendMessage(prompt)}
                            disabled={isLoading}
                            className={cn(
                              "text-sm px-4 py-2 rounded-full border",
                              "bg-background hover:bg-muted transition-colors",
                              "disabled:opacity-50 disabled:cursor-not-allowed"
                            )}
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <div
                        key={message.id}
                        className={cn(
                          'flex gap-3 p-4 rounded-lg',
                          message.role === 'user' ? 'bg-primary/5' : 'bg-muted/50'
                        )}
                      >
                        <div
                          className={cn(
                            'shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
                            message.role === 'user' 
                              ? 'bg-primary/10 text-primary' 
                              : 'bg-gradient-to-br from-violet-500 to-purple-600 text-white'
                          )}
                        >
                          {message.role === 'user' ? (
                            <User className="w-4 h-4" />
                          ) : (
                            <Sparkles className="w-4 h-4" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-muted-foreground mb-1">
                            {message.role === 'user' ? 'You' : 'AI Assistant'}
                            {message.file_name && (
                              <span className="ml-2 text-primary">
                                📎 {message.file_name}
                              </span>
                            )}
                          </p>
                          <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                            {message.content || (
                              <span className="inline-flex items-center gap-1 text-muted-foreground">
                                <span className="animate-pulse">●</span>
                                <span className="animate-pulse" style={{ animationDelay: '200ms' }}>●</span>
                                <span className="animate-pulse" style={{ animationDelay: '400ms' }}>●</span>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}

                  {error && (
                    <div className="flex items-center gap-2 p-4 rounded-lg bg-destructive/10 text-destructive text-sm">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <p>{error}</p>
                    </div>
                  )}
                </div>
              </ScrollArea>

              {/* Input Area */}
              <div className="border-t p-4 shrink-0">
                <form onSubmit={handleSubmit} className="flex gap-2 items-center">
                  <FileUploadButton
                    uploadedFile={uploadedFile}
                    onFileSelect={setUploadedFile}
                    disabled={isLoading}
                  />
                  <Input
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={uploadedFile ? `Ask about ${uploadedFile.name}...` : "Type your message..."}
                    disabled={isLoading}
                    className="flex-1"
                  />
                  <Button type="submit" disabled={isLoading || !input.trim()}>
                    {isLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                  </Button>
                </form>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default AIChat;
