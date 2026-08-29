import React, { useState, useEffect, useRef } from "react";
import {
  Bot,
  FileCode,
  Terminal,
  Trash2,
  Play,
  Square,
  UploadCloud,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  Cpu,
  ArrowRight,
  Database
} from "lucide-react";

interface BotRecord {
  id: string;
  name: string;
  filename: string;
  type: "python" | "node";
  status: "running" | "stopped" | "error";
  uptime: number | null;
  uptimeFormatted: number | null;
  pid: number | null;
  addedAt: string;
}

interface HostBotStatus {
  status: string;
  username: string;
}

export default function App() {
  const [bots, setBots] = useState<BotRecord[]>([]);
  const [hostStatus, setHostStatus] = useState<HostBotStatus>({ status: "offline", username: "Loading..." });
  const [systemStats, setSystemStats] = useState({ pythonVersion: "Detecting...", nodeVersion: "Detecting...", pipStatus: "Checking..." });
  const [loading, setLoading] = useState(true);
  
  // File upload state
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);

  // Custom modal & toast states
  const [botToDelete, setBotToDelete] = useState<{ id: string; name: string } | null>(null);
  const [notification, setNotification] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const showNotification = (type: "success" | "error", message: string) => {
    setNotification({ type, message });
    setTimeout(() => {
      setNotification(null);
    }, 5000);
  };

  // Logs drawer state
  const [activeLogBot, setActiveLogBot] = useState<BotRecord | null>(null);
  const [logs, setLogs] = useState("");
  const [refreshingLogs, setRefreshingLogs] = useState(false);
  const logContainerRef = useRef<HTMLPreElement | null>(null);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [connectionError, setConnectionError] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) {
        const data = await res.json();
        setBots(data.bots || []);
        setHostStatus(data.hostBot || { status: "offline", username: "" });
        if (data.system) {
          setSystemStats(data.system);
        }
        setConnectionError(false);
      } else {
        setConnectionError(true);
      }
    } catch (e) {
      console.error("Error fetching system status:", e);
      setConnectionError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    // Poll status every 4 seconds
    const interval = setInterval(fetchStatus, 4000);
    return () => clearInterval(interval);
  }, []);

  // Fetch logs for the active bot
  const fetchLogs = async (bot: BotRecord, quiet = false) => {
    if (!quiet) setRefreshingLogs(true);
    try {
      const res = await fetch(`/api/bots/${bot.id}/logs`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || "");
        // Scroll to bottom on load
        setTimeout(() => {
          if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
          }
        }, 50);
      }
    } catch (e) {
      setLogs("Error loading log file.");
    } finally {
      if (!quiet) setRefreshingLogs(false);
    }
  };

  // Poll logs if drawer is open and autoRefresh is on
  useEffect(() => {
    if (!activeLogBot || !autoRefresh) return;

    const interval = setInterval(() => {
      fetchLogs(activeLogBot, true);
    }, 3000);

    return () => clearInterval(interval);
  }, [activeLogBot, autoRefresh]);

  // Open Log Viewer Drawer
  const openLogs = (bot: BotRecord) => {
    setActiveLogBot(bot);
    setLogs("Loading standard outputs...");
    fetchLogs(bot);
  };

  // Toggle Start / Stop
  const handleToggleBot = async (bot: BotRecord) => {
    try {
      const res = await fetch(`/api/bots/${bot.id}/toggle`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        // Update local state immediately
        setBots(prev => prev.map(b => b.id === bot.id ? { ...b, status: data.status } : b));
        fetchStatus();
        showNotification("success", `Bot "${bot.filename}" has been ${data.status === "running" ? "started" : "stopped"}.`);
      } else {
        const errData = await res.json();
        showNotification("error", `Failed to toggle bot: ${errData.error || "Unknown server error"}`);
      }
    } catch (e: any) {
      showNotification("error", `Error toggling bot: ${e.message}`);
    }
  };

  // Delete Bot Request
  const handleDeleteBot = (botId: string, name: string) => {
    setBotToDelete({ id: botId, name });
  };

  // Confirm and Execute Delete Bot
  const confirmDeleteBot = async () => {
    if (!botToDelete) return;
    const { id: botId, name } = botToDelete;
    setBotToDelete(null);

    try {
      const res = await fetch(`/api/bots/${botId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setBots(prev => prev.filter(b => b.id !== botId));
        if (activeLogBot?.id === botId) {
          setActiveLogBot(null);
        }
        fetchStatus();
        showNotification("success", `Bot "${name}" deleted successfully.`);
      } else {
        const errData = await res.json();
        showNotification("error", `Failed to delete bot: ${errData.error || "Unknown error"}`);
      }
    } catch (e: any) {
      showNotification("error", `Error deleting bot script: ${e.message}`);
    }
  };

  // Handle Drag Events
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  // Handle File Drop
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  // Handle File Input Selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileUpload(e.target.files[0]);
    }
  };

  // Execute Upload
  const handleFileUpload = async (file: File) => {
    const isPython = file.name.endsWith(".py");
    const isNode = file.name.endsWith(".js") || file.name.endsWith(".ts");

    if (!isPython && !isNode) {
      setUploadError("Invalid file type. Only Python (.py) and Node.js (.js) files are supported.");
      setUploadSuccess(null);
      return;
    }

    setUploading(true);
    setUploadError(null);
    setUploadSuccess(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/bots/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setUploadSuccess(`"${file.name}" uploaded, dependencies resolved, and booted successfully!`);
        fetchStatus();
      } else {
        setUploadError(data.error || "Failed to process and execute the script.");
      }
    } catch (e) {
      setUploadError("A network error occurred while uploading file.");
    } finally {
      setUploading(false);
    }
  };

  // Formatter for uptime seconds
  const formatUptime = (seconds: number | null) => {
    if (seconds === null) return "Inactive";
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m ${seconds % 60}s`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col antialiased">
      {connectionError && (
        <div className="bg-amber-500 text-white text-xs font-semibold px-6 py-2 flex items-center justify-between gap-4 animate-fadeIn shadow-inner">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 animate-bounce" />
            <span>Connection to Host lost. Retrying to connect automatically...</span>
          </div>
          <button 
            onClick={fetchStatus}
            className="bg-white/20 hover:bg-white/30 text-white px-2.5 py-1 rounded transition text-[10px] font-bold uppercase tracking-wider"
          >
            Reconnect Now
          </button>
        </div>
      )}
      {/* Upper Navigation/Header */}
      <header className="border-b border-slate-200 bg-white shadow-sm sticky top-0 z-30 px-6 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center shadow-md">
            <Bot className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Telegram Bot Deployer</h1>
            <p className="text-xs text-slate-500 font-medium">Multi-Bot Sandboxed Hosting Server</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full border border-slate-200 text-xs">
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${hostStatus.status === "active" ? "bg-emerald-400" : "bg-rose-400"} opacity-75`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${hostStatus.status === "active" ? "bg-emerald-500" : "bg-rose-500"}`}></span>
            </span>
            <span className="font-semibold text-slate-700">Master Host Bot:</span>
            <span className="font-mono text-indigo-600">@{hostStatus.username}</span>
          </div>

          <a
            href="https://t.me/BotDeployerMasterBot"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 bg-indigo-600 text-white px-3.5 py-1.5 rounded-full text-xs font-semibold hover:bg-indigo-700 transition shadow-sm"
          >
            Open in Telegram <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </header>

      {/* Main Dashboard Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Stats & Script Deployment */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          
          {/* Quick Environment / Host Stats */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-slate-500" /> Host Environment Spec
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-50 border border-slate-100 p-3 rounded-lg">
                <span className="text-xs text-slate-400 font-semibold block">Python Engine</span>
                <span className="font-mono text-sm font-bold text-slate-700">{systemStats.pythonVersion}</span>
              </div>
              <div className="bg-slate-50 border border-slate-100 p-3 rounded-lg">
                <span className="text-xs text-slate-400 font-semibold block">Node Engine</span>
                <span className="font-mono text-sm font-bold text-slate-700">{systemStats.nodeVersion}</span>
              </div>
              <div className="bg-slate-50 border border-slate-100 p-3 rounded-lg">
                <span className="text-xs text-slate-400 font-semibold block">Pip Setup Status</span>
                <span className={`font-mono text-xs font-bold block ${
                  systemStats.pipStatus === "Installed" ? "text-emerald-600" : "text-amber-600 animate-pulse"
                }`}>{systemStats.pipStatus}</span>
              </div>
              <div className="bg-slate-50 border border-slate-100 p-3 rounded-lg">
                <span className="text-xs text-slate-400 font-semibold block">Auto Deploy</span>
                <span className="font-mono text-xs font-bold text-emerald-600 flex items-center gap-1">
                  Active <span className="animate-ping h-2 w-2 rounded-full bg-emerald-500 inline-block"></span>
                </span>
              </div>
            </div>
          </div>

          {/* Upload and Deploy Panel */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <UploadCloud className="h-5 w-5 text-indigo-600" /> Deploy New Bot
              </h2>
              <p className="text-slate-500 text-xs mt-1">
                Drop your script file here to parse and install imports, configure execution, and boot immediately.
              </p>
            </div>

            {/* Drag & Drop Canvas */}
            <div
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition flex flex-col items-center justify-center gap-3 cursor-pointer relative ${
                dragActive
                  ? "border-indigo-500 bg-indigo-50/50"
                  : "border-slate-200 hover:border-slate-300 bg-slate-50"
              }`}
            >
              <input
                type="file"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={handleFileChange}
                accept=".py,.js"
                disabled={uploading}
              />
              {uploading ? (
                <>
                  <Loader2 className="h-10 w-10 text-indigo-600 animate-spin" />
                  <div>
                    <span className="font-bold text-slate-800 text-sm block">Installing Dependencies...</span>
                    <span className="text-slate-500 text-xs mt-1 block">Executing pip or npm to safely download packages</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="h-12 w-12 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center">
                    <FileCode className="h-6 w-6" />
                  </div>
                  <div>
                    <span className="font-bold text-indigo-600 text-sm hover:underline block">
                      Click to choose file
                    </span>
                    <span className="text-slate-400 text-xs mt-1 block">
                      or drag & drop Python (.py) or Node.js (.js)
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Upload Feedback Alerts */}
            {uploadError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-800 p-3.5 rounded-lg flex items-start gap-2.5 text-xs">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span className="font-bold block">Deployment Error</span>
                  <pre className="font-mono mt-1 text-[10px] whitespace-pre-wrap overflow-x-auto bg-rose-100/50 p-2 rounded max-h-32">
                    {uploadError}
                  </pre>
                </div>
              </div>
            )}

            {uploadSuccess && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3.5 rounded-lg flex items-start gap-2.5 text-xs">
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block">Deployment Succeeded</span>
                  <p className="mt-1">{uploadSuccess}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Deployed Bots Listing */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col flex-1">
            <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <Database className="h-5 w-5 text-indigo-600" /> Deployed Bots ({bots.length})
                </h2>
                <p className="text-slate-500 text-xs mt-1">All managed processes on this hosting container</p>
              </div>
              <button
                onClick={fetchStatus}
                className="h-8 w-8 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-500 flex items-center justify-center transition"
                title="Refresh listings"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>

            {loading ? (
              <div className="flex-1 py-16 flex flex-col items-center justify-center gap-2">
                <Loader2 className="h-8 w-8 text-indigo-600 animate-spin" />
                <span className="text-slate-500 text-xs font-semibold">Reading deployed configurations...</span>
              </div>
            ) : bots.length === 0 ? (
              <div className="flex-1 py-16 px-6 text-center flex flex-col items-center justify-center">
                <div className="h-14 w-14 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-4">
                  <Bot className="h-8 w-8" />
                </div>
                <h3 className="font-bold text-slate-800 text-sm">No Bots Deployed</h3>
                <p className="text-slate-500 text-xs mt-1 max-w-sm mx-auto">
                  Upload a script via the left dashboard or simply send a `.py` file to the Telegram Master Bot to host your first bot!
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 overflow-y-auto max-h-[500px]">
                {bots.map((bot) => {
                  const isRunning = bot.status === "running";
                  const isError = bot.status === "error";
                  
                  return (
                    <div key={bot.id} className="p-4 hover:bg-slate-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition">
                      <div className="flex items-start gap-3">
                        <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 border ${
                          isRunning ? "bg-emerald-50 border-emerald-200 text-emerald-600" :
                          isError ? "bg-rose-50 border-rose-200 text-rose-600" : "bg-slate-50 border-slate-200 text-slate-500"
                        }`}>
                          <FileCode className="h-5 w-5" />
                        </div>
                        <div className="overflow-hidden">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-sm text-slate-900 truncate" title={bot.filename}>
                              {bot.filename}
                            </span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              bot.type === "python" ? "bg-blue-50 text-blue-700 border border-blue-200" : "bg-amber-50 text-amber-700 border border-amber-200"
                            }`}>
                              {bot.type === "python" ? "Python 3" : "Node.js"}
                            </span>
                          </div>
                          
                          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                            <div className="flex items-center gap-1.5 text-xs">
                              <span className={`h-2 w-2 rounded-full ${
                                isRunning ? "bg-emerald-500" : isError ? "bg-rose-500" : "bg-slate-400"
                              }`} />
                              <span className="text-slate-500 font-medium">
                                {bot.status.toUpperCase()}
                              </span>
                            </div>
                            <span className="text-slate-300 text-xs">|</span>
                            <span className="text-slate-400 text-xs">
                              Uptime: <span className="font-mono text-slate-600 font-semibold">{formatUptime(bot.uptimeFormatted)}</span>
                            </span>
                            {bot.pid && (
                              <>
                                <span className="text-slate-300 text-xs">|</span>
                                <span className="text-slate-400 text-xs">
                                  PID: <span className="font-mono text-slate-600 font-semibold">{bot.pid}</span>
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Bot Controls */}
                      <div className="flex items-center gap-2 self-end sm:self-center">
                        <button
                          onClick={() => handleToggleBot(bot)}
                          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm border ${
                            isRunning
                              ? "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"
                              : "bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700"
                          }`}
                        >
                          {isRunning ? (
                            <>
                              <Square className="h-3 w-3 shrink-0" /> Stop
                            </>
                          ) : (
                            <>
                              <Play className="h-3 w-3 shrink-0" /> Start
                            </>
                          )}
                        </button>

                        <button
                          onClick={() => openLogs(bot)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200 text-xs font-bold transition shadow-sm"
                        >
                          <Terminal className="h-3 w-3 shrink-0" /> Logs
                        </button>

                        <button
                          onClick={() => handleDeleteBot(bot.id, bot.filename)}
                          className="h-8 w-8 rounded-lg border border-slate-200 hover:bg-rose-50 text-slate-400 hover:text-rose-600 flex items-center justify-center transition"
                          title="Delete script"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Logs Drawer overlay */}
      {activeLogBot && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs transition">
          {/* Backdrop Click Dismiss */}
          <div className="flex-1" onClick={() => setActiveLogBot(null)} />

          {/* Console Output Drawer Container */}
          <div className="w-full max-w-2xl bg-slate-900 text-slate-200 flex flex-col h-full shadow-2xl border-l border-slate-800 animate-slide-in">
            
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2">
                <Terminal className="h-5 w-5 text-indigo-400" />
                <div>
                  <h3 className="font-bold text-sm text-white">Console Console Outputs</h3>
                  <p className="text-[10px] text-slate-400 font-mono mt-0.5">{activeLogBot.filename}</p>
                </div>
              </div>
              <button
                onClick={() => setActiveLogBot(null)}
                className="text-slate-400 hover:text-white h-7 w-7 rounded-lg hover:bg-slate-800 flex items-center justify-center transition"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            {/* Controls */}
            <div className="bg-slate-950/80 px-5 py-2.5 border-b border-slate-900 flex items-center justify-between flex-wrap gap-2 text-xs text-slate-400">
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-1.5 cursor-pointer hover:text-white select-none">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                    className="accent-indigo-500 rounded"
                  />
                  Auto-fetch updates (3s)
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => fetchLogs(activeLogBot)}
                  disabled={refreshingLogs}
                  className="inline-flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-2.5 py-1 rounded text-[11px] disabled:opacity-50 transition"
                >
                  {refreshingLogs ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Fetching
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-3 w-3" /> Fetch Now
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Terminal Body */}
            <pre
              ref={logContainerRef}
              className="flex-1 p-5 font-mono text-[11px] leading-relaxed overflow-auto select-text selection:bg-indigo-500/30 whitespace-pre-wrap bg-slate-950/40 text-emerald-400"
            >
              {logs || "Initializing capture channel... No outputs recorded."}
            </pre>

            {/* Footer */}
            <div className="p-4 bg-slate-950 border-t border-slate-900 text-[10px] text-slate-500 text-center font-mono">
              Live standard output & standard error trace capture channel
            </div>
          </div>
        </div>
      )}

      {/* Custom Delete Confirmation Modal */}
      {botToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden animate-scaleIn">
            <div className="p-6">
              <div className="h-12 w-12 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mb-4">
                <Trash2 className="h-6 w-6" />
              </div>
              <h3 className="text-lg font-bold text-slate-900">Delete Bot Script</h3>
              <p className="text-slate-500 text-xs mt-2 leading-relaxed">
                Are you absolutely sure you want to delete <span className="font-mono text-slate-800 font-semibold">{botToDelete.name}</span>? This script, its active running process, and all accumulated logs will be permanently deleted from the host disk. This action is irreversible.
              </p>
            </div>
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
              <button
                onClick={() => setBotToDelete(null)}
                className="px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-700 text-xs font-bold transition shadow-sm"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteBot}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white border border-rose-700 rounded-lg text-xs font-bold transition shadow-sm"
              >
                Yes, Delete Script
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Notification Toast */}
      {notification && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className={`p-4 rounded-xl shadow-2xl border flex items-start gap-3 max-w-sm ${
            notification.type === "success" 
              ? "bg-emerald-50 border-emerald-200 text-emerald-800" 
              : "bg-rose-50 border-rose-200 text-rose-800"
          }`}>
            {notification.type === "success" ? (
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 mt-0.5" />
            ) : (
              <AlertCircle className="h-5 w-5 shrink-0 text-rose-600 mt-0.5" />
            )}
            <div className="flex-1">
              <p className="font-bold text-xs">{notification.type === "success" ? "Success" : "Notification"}</p>
              <p className="text-xs mt-0.5 font-medium leading-relaxed">{notification.message}</p>
            </div>
            <button 
              onClick={() => setNotification(null)}
              className="text-slate-400 hover:text-slate-600"
            >
              <XCircle className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
