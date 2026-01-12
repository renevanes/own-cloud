import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { getFreshSession, verifySession } from "@/lib/auth-helpers";
import { invokeFunction } from "@/lib/functions-fetch";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

const OAuthCallback = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Connecting your account...");
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      const code = searchParams.get("code");
      const state = searchParams.get("state");
      const error = searchParams.get("error");

      // Prevent duplicate exchanges (e.g. React StrictMode double-invoking effects)
      const callbackKey = code && state ? `${state}:${code}` : null;
      if (callbackKey && handledRef.current === callbackKey) return;
      if (callbackKey) handledRef.current = callbackKey;

      if (error) {
        setStatus("error");
        setMessage(`Authorization failed: ${searchParams.get("error_description") || error}`);
        toast.error("Failed to connect account");
        setTimeout(() => navigate("/"), 3000);
        return;
      }

      if (!code || !state || !user) {
        setStatus("error");
        setMessage("Invalid callback parameters");
        toast.error("Invalid callback");
        setTimeout(() => navigate("/"), 3000);
        return;
      }

      try {
        // Get a fresh session with auto-refresh if near expiry
        const freshSession = await getFreshSession();
        
        if (!freshSession?.access_token) {
          setStatus("error");
          setMessage("Your session expired. Please sign in again.");
          toast.error("Session expired");
          await signOut();
          setTimeout(() => navigate("/auth"), 3000);
          return;
        }

        // Verify the token is actually valid
        const isValid = await verifySession(freshSession);
        if (!isValid) {
          setStatus("error");
          setMessage("Your session is invalid. Please sign in again.");
          toast.error("Session invalid");
          await signOut();
          setTimeout(() => navigate("/auth"), 3000);
          return;
        }

        console.log("oauth-callback invoke: has token", !!freshSession.access_token, "expires_at", freshSession.expires_at);

        const redirectUri = `${window.location.origin}/oauth/callback`;
        
        // Parse state to extract provider, permission level, and service
        // State format: "provider:permission_level:service" (e.g., "google:read_only:gmail")
        const stateParts = state.split(":");
        const provider = stateParts[0];
        const permissionLevel = stateParts[1] || sessionStorage.getItem("oauth_permission_level") || "read_write";
        const service = stateParts[2] || sessionStorage.getItem("oauth_service") || "drive";
        
        // userId is NOT sent - server extracts it from verified JWT
        const { data, error: fnError } = await invokeFunction<{ error?: string }>(
          "oauth-callback",
          {
            body: {
              code,
              provider,
              redirectUri,
              permissionLevel,
              service,
            },
            accessToken: freshSession.access_token,
          }
        );

        // Clear stored permission level and service
        sessionStorage.removeItem("oauth_permission_level");
        sessionStorage.removeItem("oauth_service");

        if (fnError) {
          throw fnError;
        }

        if (data?.error) {
          throw new Error(data.error);
        }

        setStatus("success");
        const providerName = provider === "microsoft" ? "OneDrive" : service === "gmail" ? "Gmail" : "Google Drive";
        setMessage(`${providerName} connected successfully!`);
        toast.success(`${providerName} connected!`);
        const redirectPath = service === "gmail" ? "/gmail" : "/";
        setTimeout(() => navigate(redirectPath), 2000);
      } catch (err: any) {
        console.error("OAuth callback error:", err);
        setStatus("error");
        setMessage(err.message || "Failed to connect account");
        toast.error("Failed to connect account");
        setTimeout(() => navigate("/"), 3000);
      }
    };

    if (user) {
      handleCallback();
    }
  }, [searchParams, user, navigate, signOut]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="glass rounded-2xl p-8 max-w-md w-full mx-4 text-center">
        {status === "loading" && (
          <Loader2 className="w-12 h-12 text-primary mx-auto mb-4 animate-spin" />
        )}
        {status === "success" && (
          <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
        {status === "error" && (
          <div className="w-12 h-12 rounded-full bg-destructive/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        )}
        <h2 className="text-xl font-display font-semibold text-foreground mb-2">
          {status === "loading" ? "Connecting..." : status === "success" ? "Connected!" : "Connection Failed"}
        </h2>
        <p className="text-muted-foreground">{message}</p>
      </div>
    </div>
  );
};

export default OAuthCallback;
