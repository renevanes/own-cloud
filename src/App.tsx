import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import Settings from "./pages/Settings";
import Browse from "./pages/Browse";
import FileExplorer from "./pages/FileExplorer";
import Synchronization from "./pages/Synchronization";
import OAuthCallback from "./pages/OAuthCallback";
import Transcribe from "./pages/Transcribe";
import TranscriptionViewer from "./pages/TranscriptionViewer";
import AIChat from "./pages/AIChat";
import Gmail from "./pages/Gmail";
import Email from "./pages/Email";
import Messages from "./pages/Messages";
import Invoices from "./pages/Invoices";
import Profile from "./pages/Profile";
import NotFound from "./pages/NotFound";
const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/browse" element={<Browse />} />
            <Route path="/files" element={<FileExplorer />} />
            <Route path="/sync" element={<Synchronization />} />
            <Route path="/transcribe" element={<Transcribe />} />
            <Route path="/transcribe/view" element={<TranscriptionViewer />} />
            <Route path="/ai-chat" element={<AIChat />} />
            <Route path="/gmail" element={<Gmail />} />
            <Route path="/email" element={<Email />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/oauth/callback" element={<OAuthCallback />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
