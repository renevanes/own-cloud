import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Trash2, Sparkles, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useAIChat, FileContext } from '@/hooks/useAIChat';
import { AIChatMessage } from './AIChatMessage';
import { cn } from '@/lib/utils';

interface AIChatPanelProps {
  open: boolean;
  onClose: () => void;
  fileContext?: FileContext;
  suggestedPrompts?: string[];
  title?: string;
}

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
  open,
  onClose,
  fileContext,
  suggestedPrompts = [],
  title = 'Ask AI',
}) => {
  const { messages, isLoading, error, sendMessage, clearMessages } = useAIChat({ fileContext });
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      sendMessage(input);
      setInput('');
    }
  };

  const handleSuggestedPrompt = (prompt: string) => {
    if (!isLoading) {
      sendMessage(prompt);
    }
  };

  const defaultPrompts = fileContext
    ? [
        'Summarize this content',
        'What are the key points?',
        'Explain this in simple terms',
      ]
    : [
        'How can I help you today?',
      ];

  const prompts = suggestedPrompts.length > 0 ? suggestedPrompts : defaultPrompts;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <div>
                <SheetTitle className="text-base">{title}</SheetTitle>
                <SheetDescription className="text-xs">
                  {fileContext ? `About: ${fileContext.fileName}` : 'Chat with AI'}
                </SheetDescription>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <Button variant="ghost" size="icon" onClick={clearMessages} title="Clear chat">
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </SheetHeader>

        {/* Messages area */}
        <ScrollArea className="flex-1 px-4" ref={scrollRef}>
          <div className="py-4 space-y-3">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Sparkles className="w-10 h-10 text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground mb-4">
                  {fileContext
                    ? `Ask me anything about "${fileContext.fileName}"`
                    : 'Start a conversation with AI'}
                </p>
                {prompts.length > 0 && (
                  <div className="flex flex-wrap gap-2 justify-center max-w-sm">
                    {prompts.map((prompt, i) => (
                      <button
                        key={i}
                        onClick={() => handleSuggestedPrompt(prompt)}
                        disabled={isLoading}
                        className={cn(
                          'text-xs px-3 py-1.5 rounded-full border',
                          'bg-background hover:bg-muted transition-colors',
                          'disabled:opacity-50 disabled:cursor-not-allowed'
                        )}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              messages.map((message) => (
                <AIChatMessage key={message.id} message={message} />
              ))
            )}

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <p>{error}</p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input area */}
        <div className="border-t p-4 shrink-0">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question..."
              disabled={isLoading}
              className="flex-1"
            />
            <Button type="submit" size="icon" disabled={isLoading || !input.trim()}>
              <Send className="w-4 h-4" />
            </Button>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
};
