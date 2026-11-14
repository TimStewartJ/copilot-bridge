import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { ThemeProvider } from "./useTheme";
import { ToastProvider } from "./useToast";
import App from "./App";
import { FileTab } from "./components/FilePreview";
import { fileFromTabPath } from "./components/file-preview";
import { initPushSubscriptionReconciliation, registerPushServiceWorker } from "./push-notifications";
import { installCleanCopy } from "./lib/clean-copy";
import "./index.css";

installCleanCopy();
initPushSubscriptionReconciliation();
void registerPushServiceWorker().catch(() => {});
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    void registerPushServiceWorker().catch(() => {});
  });
}

const tabFile = fileFromTabPath(window.location.pathname);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/+$/, "") || undefined}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ToastProvider>
            {tabFile ? <FileTab file={tabFile} /> : <App />}
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
