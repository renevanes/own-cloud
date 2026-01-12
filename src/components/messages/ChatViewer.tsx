import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, MessageSquare, Image, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface Message {
  id: string;
  sender: string;
  content: string;
  message_type: 'text' | 'media' | 'system';
  sent_at: string;
  is_outgoing: boolean;
}

interface ChatViewerProps {
  conversationName: string;
  messages: Message[];
  isLoading?: boolean;
}

export function ChatViewer({ conversationName, messages, isLoading }: ChatViewerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredMessages = searchQuery
    ? messages.filter((m) =>
        m.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.sender.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : messages;

  // Group messages by date
  const groupedMessages = filteredMessages.reduce((groups, msg) => {
    const date = format(new Date(msg.sent_at), "MMMM d, yyyy");
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(msg);
    return groups;
  }, {} as Record<string, Message[]>);

  useEffect(() => {
    // Scroll to bottom when messages change
    if (scrollRef.current && !searchQuery) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, searchQuery]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Loading messages...
      </div>
    );
  }

  if (!conversationName) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <MessageSquare className="w-16 h-16 mb-4 opacity-50" />
        <p>Select a conversation to view messages</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b flex items-center gap-3">
        <div className="flex-1">
          <h2 className="font-semibold">{conversationName}</h2>
          <p className="text-sm text-muted-foreground">
            {messages.length} messages
          </p>
        </div>
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search messages..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
        {searchQuery && filteredMessages.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No messages match your search
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(groupedMessages).map(([date, msgs]) => (
              <div key={date}>
                {/* Date separator */}
                <div className="flex items-center justify-center mb-4">
                  <Badge variant="secondary" className="text-xs">
                    {date}
                  </Badge>
                </div>

                {/* Messages for this date */}
                <div className="space-y-2">
                  {msgs.map((msg) => (
                    <MessageBubble key={msg.id} message={msg} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isSystem = message.message_type === "system";
  const isMedia = message.message_type === "media";

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="bg-muted/50 text-muted-foreground text-xs px-3 py-1 rounded-full flex items-center gap-1">
          <Info className="w-3 h-3" />
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col max-w-[75%]",
        message.is_outgoing ? "ml-auto items-end" : "mr-auto items-start"
      )}
    >
      {!message.is_outgoing && (
        <span className="text-xs font-medium text-primary mb-1 px-1">
          {message.sender}
        </span>
      )}
      <div
        className={cn(
          "px-3 py-2 rounded-2xl",
          message.is_outgoing
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-muted rounded-bl-md"
        )}
      >
        {isMedia ? (
          <div className="flex items-center gap-2 text-sm opacity-75">
            <Image className="w-4 h-4" />
            <span>{message.content}</span>
          </div>
        ) : (
          <p className="text-sm whitespace-pre-wrap break-words">
            {message.content}
          </p>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground mt-1 px-1">
        {format(new Date(message.sent_at), "h:mm a")}
      </span>
    </div>
  );
}
