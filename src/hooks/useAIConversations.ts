import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface AIConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AIMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  file_name: string | null;
  file_type: string | null;
  file_content: string | null;
  created_at: string;
}

export const useAIConversations = () => {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<AIConversation[]>([]);
  const [currentConversation, setCurrentConversation] = useState<AIConversation | null>(null);
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConversations = useCallback(async () => {
    if (!user) return;
    
    const { data, error } = await supabase
      .from('ai_conversations')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });
    
    if (error) {
      console.error('Failed to fetch conversations:', error);
      return;
    }
    
    setConversations(data || []);
    setLoading(false);
  }, [user]);

  const fetchMessages = useCallback(async (conversationId: string) => {
    if (!user) return;
    
    const { data, error } = await supabase
      .from('ai_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    
    if (error) {
      console.error('Failed to fetch messages:', error);
      return;
    }
    
    setMessages((data || []) as AIMessage[]);
  }, [user]);

  const createConversation = useCallback(async (title?: string): Promise<AIConversation | null> => {
    if (!user) return null;
    
    const { data, error } = await supabase
      .from('ai_conversations')
      .insert({
        user_id: user.id,
        title: title || 'New Conversation',
      })
      .select()
      .single();
    
    if (error) {
      console.error('Failed to create conversation:', error);
      return null;
    }
    
    setConversations(prev => [data, ...prev]);
    setCurrentConversation(data);
    setMessages([]);
    return data;
  }, [user]);

  const updateConversationTitle = useCallback(async (conversationId: string, title: string) => {
    const { error } = await supabase
      .from('ai_conversations')
      .update({ title })
      .eq('id', conversationId);
    
    if (error) {
      console.error('Failed to update conversation title:', error);
      return;
    }
    
    setConversations(prev => 
      prev.map(c => c.id === conversationId ? { ...c, title } : c)
    );
    
    if (currentConversation?.id === conversationId) {
      setCurrentConversation(prev => prev ? { ...prev, title } : null);
    }
  }, [currentConversation]);

  const deleteConversation = useCallback(async (conversationId: string) => {
    const { error } = await supabase
      .from('ai_conversations')
      .delete()
      .eq('id', conversationId);
    
    if (error) {
      console.error('Failed to delete conversation:', error);
      return;
    }
    
    setConversations(prev => prev.filter(c => c.id !== conversationId));
    
    if (currentConversation?.id === conversationId) {
      setCurrentConversation(null);
      setMessages([]);
    }
  }, [currentConversation]);

  const addMessage = useCallback(async (
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    fileInfo?: { fileName: string; fileType: string; fileContent: string }
  ): Promise<AIMessage | null> => {
    if (!user) return null;
    
    const { data, error } = await supabase
      .from('ai_messages')
      .insert({
        conversation_id: conversationId,
        user_id: user.id,
        role,
        content,
        file_name: fileInfo?.fileName || null,
        file_type: fileInfo?.fileType || null,
        file_content: fileInfo?.fileContent || null,
      })
      .select()
      .single();
    
    if (error) {
      console.error('Failed to add message:', error);
      return null;
    }
    
    // Update conversation's updated_at
    await supabase
      .from('ai_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);
    
    return data as AIMessage;
  }, [user]);

  const selectConversation = useCallback(async (conversation: AIConversation) => {
    setCurrentConversation(conversation);
    await fetchMessages(conversation.id);
  }, [fetchMessages]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  return {
    conversations,
    currentConversation,
    messages,
    loading,
    createConversation,
    selectConversation,
    updateConversationTitle,
    deleteConversation,
    addMessage,
    setMessages,
    setCurrentConversation,
    refetch: fetchConversations,
  };
};
