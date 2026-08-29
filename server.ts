import express from "express";
import path from "path";
import fs from "fs";
import { spawn, ChildProcess, execSync } from "child_process";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import dotenv from "dotenv";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
let TelegramBot = require("node-telegram-bot-api");
if (TelegramBot.default) {
  TelegramBot = TelegramBot.default;
}

dotenv.config();

let cachedPythonVersion = "Python 3";
let cachedNodeVersion = "v22.x LTS";
let pipStatus = "Checking...";

try {
  cachedPythonVersion = execSync("python3 --version").toString().trim();
} catch (e) {
  try {
    cachedPythonVersion = execSync("python --version").toString().trim();
  } catch (err) {}
}

try {
  cachedNodeVersion = execSync("node --version").toString().trim();
} catch (e) {}

// Automatic pip installation engine
function ensurePipInstalled() {
  try {
    execSync("pip3 --version");
    console.log("pip3 is already present on the system.");
    pipStatus = "Installed";
  } catch (e) {
    console.log("pip3 is missing. Initiating automatic setup...");
    pipStatus = "Installing...";
    
    const proc = spawn("sh", ["-c", "apt-get update && apt-get install -y python3-pip"]);
    proc.stdout.on("data", (data) => console.log(`[pip-install] ${data}`));
    proc.stderr.on("data", (data) => console.error(`[pip-install-err] ${data}`));
    proc.on("close", (code) => {
      if (code === 0) {
        console.log("pip3 successfully auto-installed on startup!");
        pipStatus = "Installed";
        try {
          cachedPythonVersion = execSync("python3 --version").toString().trim();
        } catch (err) {}
      } else {
        console.error(`Automatic pip3 installation failed with exit code ${code}.`);
        pipStatus = "Installation Failed";
      }
    });
  }
}

// Start auto-pip check
ensurePipInstalled();

const app = express();
const PORT = 3000;

// Process-level uncaught protection to prevent unexpected socket crashes
process.on("uncaughtException", (err) => {
  console.error("SERVER CRITICAL UNCAUGHT EXCEPTION:", err.message || err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("SERVER CRITICAL UNHANDLED REJECTION AT:", promise, "REASON:", reason);
});

// Robust CORS headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Ensure storage directories exist
const BOTS_DIR = path.join(process.cwd(), "bots");
const LOGS_DIR = path.join(BOTS_DIR, "logs");
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Set up file storage for web uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, BOTS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage });

app.use(express.json());

// Webhook endpoint for the Telegram Master Bot
app.post("/api/telegram-webhook", (req, res) => {
  if (masterBot) {
    try {
      masterBot.processUpdate(req.body);
    } catch (e: any) {
      console.error("Error processing Telegram update via webhook:", e.message || e);
    }
  }
  res.sendStatus(200);
});

// In-memory process and database state
interface BotRecord {
  id: string;
  name: string;
  filename: string;
  type: "python" | "node";
  status: "running" | "stopped" | "error";
  uptime: number | null;
  pid: number | null;
  addedAt: string;
  code?: string;
}

let bots: BotRecord[] = [];
const activeProcesses: Record<string, ChildProcess> = {};
const BOTS_JSON_PATH = path.join(BOTS_DIR, "bots.json");

// Load & Save Bots DB
function loadBots() {
  try {
    if (fs.existsSync(BOTS_JSON_PATH)) {
      bots = JSON.parse(fs.readFileSync(BOTS_JSON_PATH, "utf-8"));
      // On startup, mark all as stopped/offline initially, then auto-restart running ones
      bots = bots.map(b => {
        // Restore missing files from the saved code
        if (b.code && !fs.existsSync(path.join(BOTS_DIR, b.filename))) {
          try {
            fs.writeFileSync(path.join(BOTS_DIR, b.filename), b.code, "utf-8");
            console.log(`Restoring missing bot file on startup: ${b.filename}`);
          } catch (err: any) {
            console.error(`Failed to restore bot file ${b.filename}:`, err.message);
          }
        }
        return { ...b, status: "stopped", pid: null, uptime: null };
      });
    } else {
      bots = [];
      saveBots();
    }
  } catch (error) {
    console.error("Error loading bots.json:", error);
    bots = [];
  }
}

function saveBots() {
  try {
    fs.writeFileSync(BOTS_JSON_PATH, JSON.stringify(bots, null, 2), "utf-8");
  } catch (error) {
    console.error("Error saving bots.json:", error);
  }
}

loadBots();

// Dependency Parsers
function parsePythonImports(content: string): string[] {
  const imports = new Set<string>();
  const lines = content.split("\n");
  
  // Look for import and from imports
  const importRegex = /^\s*import\s+([a-zA-Z0-9_,\s]+)/;
  const fromRegex = /^\s*from\s+([a-zA-Z0-9_]+)/;

  for (const line of lines) {
    const importMatch = line.match(importRegex);
    if (importMatch) {
      const modules = importMatch[1].split(",");
      for (let mod of modules) {
        mod = mod.trim().split(".")[0].split(/\s+/)[0];
        if (mod) imports.add(mod);
      }
    }
    const fromMatch = line.match(fromRegex);
    if (fromMatch) {
      const mod = fromMatch[1].trim().split(".")[0];
      if (mod) imports.add(mod);
    }

    // Parse comments like: # pip: module1==version, module2
    const inlineMatch = line.match(/#\s*(?:pip|requirements|dependencies|depends|packages|install):\s*(.+)/i);
    if (inlineMatch) {
      const inlineDeps = inlineMatch[1].split(/[\s,]+/);
      for (const dep of inlineDeps) {
        const cleaned = dep.trim();
        if (cleaned) {
          imports.add(cleaned);
        }
      }
    }
  }

  // Filter out python built-in modules
  const builtIns = new Set([
    "os", "sys", "time", "json", "math", "random", "subprocess", "re", "logging",
    "collections", "itertools", "functools", "datetime", "threading", "asyncio",
    "socket", "select", "urllib", "hashlib", "hmac", "base64", "uuid", "tempfile",
    "shutil", "glob", "fnmatch", "sqlite3", "csv", "xml", "html", "configparser",
    "argparse", "getpass", "platform", "traceback", "inspect", "typing", "struct"
  ]);

  return Array.from(imports).filter(mod => {
    const base = mod.split(/[=<>;!]/)[0].trim();
    return !builtIns.has(base);
  });
}

function parseNodeImports(content: string): string[] {
  const imports = new Set<string>();
  const lines = content.split("\n");
  
  // match require('pkg') or require("pkg")
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  // match import ... from 'pkg'
  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  // match import('pkg')
  const dynamicImportRegex = /import\s*\(['"]([^'"]+)['"]\)/g;

  let match;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.add(match[1].split("/")[0]);
  }
  while ((match = importRegex.exec(content)) !== null) {
    imports.add(match[1].split("/")[0]);
  }
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    imports.add(match[1].split("/")[0]);
  }

  // Parse comments like: // npm: dotenv@16.0.0, node-telegram-bot-api
  for (const line of lines) {
    const inlineMatch = line.match(/\/\/\s*(?:npm|dependencies|depends|packages|install):\s*(.+)/i);
    if (inlineMatch) {
      const inlineDeps = inlineMatch[1].split(/[\s,]+/);
      for (const dep of inlineDeps) {
        const cleaned = dep.trim();
        if (cleaned) {
          imports.add(cleaned);
        }
      }
    }
  }

  const builtIns = new Set([
    "fs", "path", "os", "child_process", "http", "https", "crypto", "stream",
    "util", "events", "readline", "url", "querystring", "dns", "net", "dgram",
    "tls", "assert", "vm", "buffer", "cluster", "readline", "repl", "v8"
  ]);

  return Array.from(imports).filter(mod => {
    const base = mod.split("@")[0].trim();
    return !builtIns.has(base) && !base.startsWith(".") && !base.startsWith("@/");
  });
}

// Module Mappers
const pythonPackageMap: Record<string, string> = {
  "telebot": "pyTelegramBotAPI",
  "telegram": "python-telegram-bot",
  "discord": "discord.py",
  "jinja2": "Jinja2",
  "bs4": "beautifulsoup4",
  "PIL": "Pillow",
  "yaml": "PyYAML",
  "jwt": "PyJWT",
  "dotenv": "python-dotenv",
  "socketio": "python-socketio",
  "google": "google-generativeai"
};

// Install Dependencies
function installPythonPackages(packages: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (packages.length === 0) return resolve("No dependencies to install.");
    
    const mapped = packages.map(pkg => {
      // Split on operators to get the raw module name and version part separately
      const match = pkg.match(/^([a-zA-Z0-9_-]+)(.*)$/);
      if (!match) return pkg;
      const base = match[1];
      const rest = match[2];
      const mappedBase = pythonPackageMap[base] || base;
      return mappedBase + rest;
    });
    console.log(`Installing Python packages: ${mapped.join(", ")}`);
    
    const proc = spawn("pip3", ["install", "--no-cache-dir", "--break-system-packages", ...mapped]);
    let output = "";
    proc.stdout.on("data", (data) => output += data.toString());
    proc.stderr.on("data", (data) => output += data.toString());
    
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Failed to install Python dependencies. Output:\n${output}`));
      }
    });
  });
}

function installNodePackages(packages: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (packages.length === 0) return resolve("No dependencies to install.");
    
    console.log(`Installing Node packages: ${packages.join(", ")}`);
    const proc = spawn("npm", ["install", "--no-save", ...packages]);
    let output = "";
    proc.stdout.on("data", (data) => output += data.toString());
    proc.stderr.on("data", (data) => output += data.toString());
    
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Failed to install Node dependencies. Output:\n${output}`));
      }
    });
  });
}

// Process Management
function startBot(botId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const bot = bots.find(b => b.id === botId);
    if (!bot) return reject(new Error("Bot not found"));
    
    if (activeProcesses[botId]) {
      return resolve(); // Already running
    }

    const scriptPath = path.join(BOTS_DIR, bot.filename);
    const logFilePath = path.join(LOGS_DIR, `${bot.filename}.log`);

    // Ensure the script file exists, recover from code if missing, or error out
    if (!fs.existsSync(scriptPath)) {
      if (bot.code) {
        try {
          fs.writeFileSync(scriptPath, bot.code, "utf-8");
          console.log(`Restored bot file before starting: ${bot.filename}`);
        } catch (err: any) {
          return reject(new Error(`Source file missing and could not be restored: ${err.message}`));
        }
      } else {
        return reject(new Error("Source file missing. Please re-upload the bot file."));
      }
    }
    
    // Create empty/clear log file
    fs.writeFileSync(logFilePath, `--- Bot Started at ${new Date().toISOString()} ---\n`, "utf-8");
    const logStream = fs.createWriteStream(logFilePath, { flags: "a" });

    let proc: ChildProcess;
    if (bot.type === "python") {
      proc = spawn("python3", [scriptPath], {
        env: { ...process.env, PYTHONUNBUFFERED: "1" }
      });
    } else {
      proc = spawn("node", [scriptPath], {
        env: { ...process.env }
      });
    }

    proc.stdout?.on("data", (data) => {
      logStream.write(data);
    });

    proc.stderr?.on("data", (data) => {
      logStream.write(data);
    });

    proc.on("error", (err) => {
      logStream.write(`\nProcess Error: ${err.message}\n`);
      bot.status = "error";
      bot.pid = null;
      bot.uptime = null;
      saveBots();
    });

    proc.on("close", (code) => {
      logStream.write(`\n--- Process exited with code ${code} at ${new Date().toISOString()} ---\n`);
      logStream.end();
      delete activeProcesses[botId];
      
      if (bot.status === "running") {
        bot.status = code === 0 ? "stopped" : "error";
      }
      bot.pid = null;
      bot.uptime = null;
      saveBots();
    });

    activeProcesses[botId] = proc;
    bot.status = "running";
    bot.pid = proc.pid || null;
    bot.uptime = Date.now();
    saveBots();
    
    resolve();
  });
}

function stopBot(botId: string) {
  const bot = bots.find(b => b.id === botId);
  if (!bot) return;

  const proc = activeProcesses[botId];
  if (proc) {
    try {
      proc.kill("SIGTERM");
    } catch (e) {
      console.error(`Error killing process ${botId}:`, e);
    }
    delete activeProcesses[botId];
  }

  bot.status = "stopped";
  bot.pid = null;
  bot.uptime = null;
  saveBots();
}

function deleteBotFromDisk(botId: string) {
  stopBot(botId);
  const botIndex = bots.findIndex(b => b.id === botId);
  if (botIndex !== -1) {
    const bot = bots[botIndex];
    const scriptPath = path.join(BOTS_DIR, bot.filename);
    const logPath = path.join(LOGS_DIR, `${bot.filename}.log`);
    
    try {
      if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
      if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    } catch (e) {
      console.error("Error deleting bot files:", e);
    }

    bots.splice(botIndex, 1);
    saveBots();
  }
}

// Automatically restart bots that were marked "running" on previous session
setTimeout(() => {
  try {
    if (fs.existsSync(BOTS_JSON_PATH)) {
      const savedBots: BotRecord[] = JSON.parse(fs.readFileSync(BOTS_JSON_PATH, "utf-8"));
      savedBots.forEach(b => {
        // We can choose to auto-restart them if they were running previously
        if (b.status === "running") {
          console.log(`Auto-restarting bot ${b.filename}...`);
          startBot(b.id).catch(err => console.error(`Failed auto-starting ${b.filename}:`, err));
        }
      });
    }
  } catch (err) {
    console.error("Auto-restart error:", err);
  }
}, 2000);


// API REST Routes
app.get("/api/status", (req, res) => {
  res.json({
    hostBot: {
      status: masterBot ? "active" : "offline",
      username: masterBotUsername,
    },
    system: {
      pythonVersion: cachedPythonVersion,
      nodeVersion: cachedNodeVersion,
      pipStatus: pipStatus,
    },
    bots: bots.map(b => ({
      ...b,
      uptimeFormatted: b.uptime ? Math.floor((Date.now() - b.uptime) / 1000) : null
    }))
  });
});

app.get("/api/bots/:id/logs", (req, res) => {
  const bot = bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  
  const logPath = path.join(LOGS_DIR, `${bot.filename}.log`);
  if (!fs.existsSync(logPath)) {
    return res.json({ logs: "No logs found for this bot." });
  }

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    // Limit to last 500 lines
    const lines = content.split("\n");
    const lastLines = lines.slice(-500).join("\n");
    res.json({ logs: lastLines });
  } catch (error) {
    res.status(500).json({ error: "Could not read logs file" });
  }
});

app.post("/api/bots/:id/toggle", async (req, res) => {
  const bot = bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });

  try {
    if (bot.status === "running") {
      stopBot(bot.id);
      res.json({ success: true, status: "stopped" });
    } else {
      await startBot(bot.id);
      res.json({ success: true, status: "running" });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/bots/:id", (req, res) => {
  const bot = bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });

  deleteBotFromDisk(bot.id);
  res.json({ success: true });
});

app.post("/api/bots/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const filename = req.file.originalname;
  const isPython = filename.endsWith(".py");
  const isNode = filename.endsWith(".js") || filename.endsWith(".ts");

  if (!isPython && !isNode) {
    // delete file
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Only Python (.py) and Node.js (.js, .ts) files are supported." });
  }

  const botId = filename.toLowerCase().replace(/[^a-z0-9]/g, "-");
  
  // check if exists, stop it first
  const existingIndex = bots.findIndex(b => b.id === botId);
  if (existingIndex !== -1) {
    stopBot(botId);
    bots.splice(existingIndex, 1);
  }

  const content = fs.readFileSync(req.file.path, "utf-8");
  const type = isPython ? "python" : "node";

  // New Record
  const newBot: BotRecord = {
    id: botId,
    name: filename,
    filename,
    type,
    status: "stopped",
    uptime: null,
    pid: null,
    addedAt: new Date().toISOString(),
    code: content
  };

  bots.push(newBot);
  saveBots();

  // Resolve dependencies async
  try {
    let deps: string[] = [];
    if (type === "python") {
      deps = parsePythonImports(content);
      await installPythonPackages(deps);
    } else {
      deps = parseNodeImports(content);
      await installNodePackages(deps);
    }

    await startBot(botId);
    res.json({ success: true, bot: newBot, dependencies: deps });
  } catch (error: any) {
    console.error("Error setting up uploaded bot:", error);
    newBot.status = "error";
    saveBots();
    res.json({ success: false, error: error.message, bot: newBot });
  }
});


// Telegram Bot Initialization
const MASTER_TOKEN = "8923444398:AAF68GO0jb3_1ofreVAnMF7APcfdoIY0_K4";
let masterBot: any = null;
let masterBotUsername = "BotDeployerMasterBot";

function initTelegramMasterBot() {
  try {
    const APP_URL = process.env.APP_URL;
    const isProduction = process.env.NODE_ENV === "production" || (APP_URL && !APP_URL.includes("localhost"));

    if (isProduction && APP_URL) {
      console.log(`Initializing Master Bot in WEBHOOK mode targeting: ${APP_URL}`);
      masterBot = new TelegramBot(MASTER_TOKEN, { polling: false });
      
      const webhookUrl = `${APP_URL}/api/telegram-webhook`;
      masterBot.setWebHook(webhookUrl)
        .then(() => console.log(`Telegram webhook successfully set to: ${webhookUrl}`))
        .catch((err: any) => console.error("Error setting Telegram webhook:", err.message || err));
    } else {
      console.log("Initializing Master Bot in POLLING mode...");
      masterBot = new TelegramBot(MASTER_TOKEN, { polling: true });
      
      masterBot.deleteWebHook()
        .then(() => console.log("Telegram webhook deleted successfully for polling mode."))
        .catch((err: any) => console.error("Error deleting Telegram webhook:", err.message || err));

      masterBot.on("polling_error", (error: any) => {
        if (error.message && error.message.includes("409 Conflict")) {
          console.warn("Telegram Master Bot Polling Conflict (409): Another instance is running.");
        } else {
          console.error("Telegram Master Bot Polling Error:", error.message || error);
        }
      });
    }
    
    masterBot.getMe().then((me: any) => {
      masterBotUsername = me.username || "BotDeployerMasterBot";
      console.log(`Master Bot initialized successfully: @${masterBotUsername}`);
    }).catch((e: any) => {
      console.error("Error fetching master bot info (invalid token?):", e.message);
    });

    // Custom Keyboards
    const mainMenuKeyboard = {
      reply_markup: {
        keyboard: [
          [{ text: "📊 Status Overview" }, { text: "📁 Upload Script Info" }],
          [{ text: "📄 View Log Files" }, { text: "🌐 Open Admin Panel" }]
        ],
        resize_keyboard: true
      }
    };

    // Helper to get active panels link
    const getPanelUrl = () => {
      return process.env.APP_URL || `http://localhost:${PORT}`;
    };

    // Start Command / Button
    masterBot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      const response = `👋 *Welcome to the Telegram Bot Deployer Host!* \n\n` +
        `This system allows you to upload, host, and monitor Telegram bots (Python and Node.js) directly inside Telegram or via our web interface.\n\n` +
        `*Available Controls:* \n` +
        `• 📁 *Drag & drop / Upload* any \`.py\` or \`.js\` file directly to this chat.\n` +
        `• /status - See all currently hosted bots and toggle them.\n` +
        `• /logs - Read log outputs for running bots.\n` +
        `• /panel - Receive a direct secure link to the Web Admin Panel.\n\n` +
        `Use the buttons below for quick navigation!`;
      
      masterBot?.sendMessage(chatId, response, {
        parse_mode: "Markdown",
        ...mainMenuKeyboard
      });
    });

    // Panel Command
    masterBot.onText(/\/panel/, (msg) => {
      const chatId = msg.chat.id;
      const url = getPanelUrl();
      masterBot?.sendMessage(chatId, `🌐 *Web Control Panel*\n\nAccess the central monitoring dashboard, view real-time logs, and manage dependencies visually:`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔗 Open Web Panel", url: url }]
          ]
        }
      });
    });

    // Status Command & Button
    const sendStatusMessage = (chatId: number) => {
      if (bots.length === 0) {
        masterBot?.sendMessage(chatId, "📭 *No bots deployed yet.*\nSimply upload a `.py` (Python) or `.js` (Node.js) bot script directly to this chat!", {
          parse_mode: "Markdown"
        });
        return;
      }

      const activeCount = bots.filter(b => b.status === "running").length;
      let text = `🤖 *Deployer Host Status*\n` +
        `Total Bots Deployed: *${bots.length}*\n` +
        `Active / Running: *${activeCount}*\n\n` +
        `*Your Bot List:*`;
      
      const keyboard: any[] = [];
      bots.forEach(bot => {
        const icon = bot.status === "running" ? "🟢" : bot.status === "error" ? "🔴" : "⚪";
        text += `\n${icon} *${bot.filename}* (${bot.type}) - _${bot.status}_`;
        
        // inline controls
        const label = bot.status === "running" ? `Stop ⏹️` : `Start ▶️`;
        keyboard.push([
          { text: `${bot.filename} (${bot.status === "running" ? "Stop" : "Start"})`, callback_data: `toggle_${bot.id}` },
          { text: `Logs 📄`, callback_data: `logs_${bot.id}` },
          { text: `Delete 🗑️`, callback_data: `confirm_del_${bot.id}` }
        ]);
      });

      masterBot?.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
    };

    masterBot.onText(/\/status/, (msg) => {
      sendStatusMessage(msg.chat.id);
    });

    // Watch for text button clicks
    masterBot.on("message", (msg) => {
      if (!msg.text) return;
      const text = msg.text;
      const chatId = msg.chat.id;

      if (text === "📊 Status Overview") {
        sendStatusMessage(chatId);
      } else if (text === "📁 Upload Script Info") {
        masterBot?.sendMessage(chatId, `📁 *How to Deploy a Bot*\n\n` +
          `1. Send your script file (\`.py\` or \`.js\`) directly as a document to this chat.\n` +
          `2. The host will parse dependencies (e.g. \`telebot\`, \`requests\`, \`dotenv\`, \`axios\`, etc.).\n` +
          `3. Python pip or Node npm packages will be installed automatically.\n` +
          `4. Your bot will launch instantly!`, { parse_mode: "Markdown" });
      } else if (text === "📄 View Log Files") {
        if (bots.length === 0) {
          masterBot?.sendMessage(chatId, "No bots deployed yet to view logs.");
          return;
        }
        const buttons = bots.map(b => [{ text: `Logs for ${b.filename}`, callback_data: `logs_${b.id}` }]);
        masterBot?.sendMessage(chatId, "Select a bot to fetch the latest console logs:", {
          reply_markup: { inline_keyboard: buttons }
        });
      } else if (text === "🌐 Open Admin Panel") {
        const url = getPanelUrl();
        masterBot?.sendMessage(chatId, `Open the Web Control Panel:`, {
          reply_markup: {
            inline_keyboard: [[{ text: "🔗 Go to Panel", url: url }]]
          }
        });
      }
    });

    // File / Document Listener (automatic script deployer)
    masterBot.on("document", async (msg) => {
      const chatId = msg.chat.id;
      const doc = msg.document;
      if (!doc) return;

      const filename = doc.file_name || "script.py";
      const isPython = filename.endsWith(".py");
      const isNode = filename.endsWith(".js") || filename.endsWith(".ts");

      if (!isPython && !isNode) {
        masterBot?.sendMessage(chatId, "⚠️ *Unsupported format!* Please upload a `.py` (Python) or `.js` (Node.js) file.", { parse_mode: "Markdown" });
        return;
      }

      const botId = filename.toLowerCase().replace(/[^a-z0-9]/g, "-");
      const statusMsg = await masterBot?.sendMessage(chatId, `📥 *Downloading ${filename}...*`, { parse_mode: "Markdown" });

      try {
        const fileLink = await masterBot?.getFileLink(doc.file_id);
        if (!fileLink) throw new Error("Could not fetch file download link from Telegram.");

        const res = await fetch(fileLink);
        const buffer = await res.arrayBuffer();
        const scriptContent = Buffer.from(buffer);

        // Ensure directories exist
        const scriptPath = path.join(BOTS_DIR, filename);
        fs.writeFileSync(scriptPath, scriptContent);

        // Remove existing process if duplicate id
        const existingIndex = bots.findIndex(b => b.id === botId);
        if (existingIndex !== -1) {
          stopBot(botId);
          bots.splice(existingIndex, 1);
        }

        const type = isPython ? "python" : "node";
        const contentStr = scriptContent.toString("utf-8");

        // Create DB record
        const newBot: BotRecord = {
          id: botId,
          name: filename,
          filename,
          type,
          status: "stopped",
          uptime: null,
          pid: null,
          addedAt: new Date().toISOString(),
          code: contentStr
        };
        bots.push(newBot);
        saveBots();

        // Dependencies resolution
        let deps: string[] = [];
        if (type === "python") {
          masterBot?.editMessageText(`🔍 *Parsing Python imports...*`, { chat_id: chatId, message_id: statusMsg?.message_id, parse_mode: "Markdown" });
          deps = parsePythonImports(contentStr);
          if (deps.length > 0) {
            masterBot?.editMessageText(`⚡ *Installing Python pip packages:* \`${deps.join(", ")}\`...`, { chat_id: chatId, message_id: statusMsg?.message_id, parse_mode: "Markdown" });
            await installPythonPackages(deps);
          }
        } else {
          masterBot?.editMessageText(`🔍 *Parsing Node imports...*`, { chat_id: chatId, message_id: statusMsg?.message_id, parse_mode: "Markdown" });
          deps = parseNodeImports(contentStr);
          if (deps.length > 0) {
            masterBot?.editMessageText(`⚡ *Installing Node npm modules:* \`${deps.join(", ")}\`...`, { chat_id: chatId, message_id: statusMsg?.message_id, parse_mode: "Markdown" });
            await installNodePackages(deps);
          }
        }

        // Start Bot
        masterBot?.editMessageText(`🚀 *Booting bot ${filename}...*`, { chat_id: chatId, message_id: statusMsg?.message_id, parse_mode: "Markdown" });
        await startBot(botId);

        masterBot?.editMessageText(`✅ *Bot Successfully Deployed!* \n\n` +
          `• *Bot:* \`${filename}\`\n` +
          `• *Platform:* \`${type === "python" ? "Python 3" : "Node.js"}\`\n` +
          `• *Status:* \`Running (PID: ${activeProcesses[botId]?.pid || "N/A"})\`\n` +
          `• *Dependencies:* \`${deps.length > 0 ? deps.join(", ") : "None"}\`\n\n` +
          `You can monitor and manage it with /status!`, { chat_id: chatId, message_id: statusMsg?.message_id, parse_mode: "Markdown" });

      } catch (err: any) {
        console.error("Deploy error via Telegram:", err);
        masterBot?.editMessageText(`❌ *Deployment Failed!*\n\nError description:\n\`${err.message}\``, { chat_id: chatId, message_id: statusMsg?.message_id, parse_mode: "Markdown" });
        
        const b = bots.find(b => b.id === botId);
        if (b) {
          b.status = "error";
          saveBots();
        }
      }
    });

    // Inline Button Queries
    masterBot.on("callback_query", async (query) => {
      const data = query.data;
      const chatId = query.message?.chat.id;
      const messageId = query.message?.message_id;

      if (!data || !chatId || !messageId) return;

      // Toggle bot start/stop
      if (data.startsWith("toggle_")) {
        const botId = data.replace("toggle_", "");
        const bot = bots.find(b => b.id === botId);
        if (!bot) {
          masterBot?.answerCallbackQuery(query.id, { text: "Bot record not found." });
          return;
        }

        try {
          if (bot.status === "running") {
            stopBot(botId);
            masterBot?.answerCallbackQuery(query.id, { text: `Stopped ${bot.filename}` });
          } else {
            masterBot?.answerCallbackQuery(query.id, { text: `Starting ${bot.filename}...` });
            await startBot(botId);
          }
          sendStatusMessage(chatId);
          // Delete old status overview menu to keep conversation clean
          masterBot?.deleteMessage(chatId, messageId).catch(() => {});
        } catch (e: any) {
          masterBot?.sendMessage(chatId, `⚠️ Failed starting *${bot.filename}*:\n\`${e.message}\``, { parse_mode: "Markdown" });
        }
      }

      // Fetch logs
      else if (data.startsWith("logs_")) {
        const botId = data.replace("logs_", "");
        const bot = bots.find(b => b.id === botId);
        if (!bot) {
          masterBot?.answerCallbackQuery(query.id, { text: "Bot not found." });
          return;
        }

        const logPath = path.join(LOGS_DIR, `${bot.filename}.log`);
        masterBot?.answerCallbackQuery(query.id, { text: "Fetching logs..." });

        if (!fs.existsSync(logPath)) {
          masterBot?.sendMessage(chatId, `📄 *Logs for ${bot.filename}:*\nNo logs recorded yet.`, { parse_mode: "Markdown" });
          return;
        }

        try {
          const logs = fs.readFileSync(logPath, "utf-8");
          const lastLines = logs.split("\n").slice(-25).join("\n");
          masterBot?.sendMessage(chatId, `📄 *Latest Logs for ${bot.filename} (Last 25 lines):*\n\n\`\`\`\n${lastLines || "No active logs."}\n\`\`\``, { parse_mode: "Markdown" });
        } catch (e) {
          masterBot?.sendMessage(chatId, `❌ Could not read logs for ${bot.filename}`);
        }
      }

      // Confirm Delete
      else if (data.startsWith("confirm_del_")) {
        const botId = data.replace("confirm_del_", "");
        const bot = bots.find(b => b.id === botId);
        if (!bot) return;

        masterBot?.answerCallbackQuery(query.id, { text: "Are you sure?" });
        masterBot?.sendMessage(chatId, `⚠️ *Are you absolutely sure you want to delete ${bot.filename}?*\nThis deletes the script and logs forever.`, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔥 Yes, Delete", callback_data: `delete_${bot.id}` },
                { text: "❌ Cancel", callback_data: "cancel_del" }
              ]
            ]
          }
        });
      }

      // Execute Delete
      else if (data.startsWith("delete_")) {
        const botId = data.replace("delete_", "");
        const bot = bots.find(b => b.id === botId);
        if (!bot) return;

        deleteBotFromDisk(botId);
        masterBot?.answerCallbackQuery(query.id, { text: `Deleted ${bot.filename}` });
        masterBot?.editMessageText(`🗑️ *${bot.filename}* has been deleted successfully.`, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" });
        
        // Refresh status
        setTimeout(() => sendStatusMessage(chatId), 1000);
      }

      // Cancel Delete
      else if (data === "cancel_del") {
        masterBot?.answerCallbackQuery(query.id, { text: "Deletion canceled." });
        masterBot?.deleteMessage(chatId, messageId).catch(() => {});
      }
    });

  } catch (error) {
    console.error("Fatal error starting master Telegram bot:", error);
  }
}

// Start bot
initTelegramMasterBot();


// Vite asset serving setup
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Telegram Bot Host and Web Admin running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
