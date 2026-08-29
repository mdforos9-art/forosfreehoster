# Sample Telegram Bot Script (python.py)
# This is a template/example bot that you can upload to your Deployer Host!
# The Deployer Host will automatically install any imported packages (like pyTelegramBotAPI and requests).

import os
import time
import socket
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
import requests
import telebot # This will trigger the installer to get 'pyTelegramBotAPI'

# -------------------------------------------------------------
# Configuration
# -------------------------------------------------------------
HOST_IP = "0.0.0.0"
HOST_PORT = 5000
TARGET_SOCKET_HOST = "8.8.8.8"
TARGET_SOCKET_PORT = 80

# Retrieve token from environment or use a custom one
BOT_TOKEN = "8923444398:AAF68GO0jb3_1ofreVAnMF7APcfdoIY0_K4"

print(f"Booting custom child Python bot & server...")
print(f"Configured IP: {HOST_IP}")
print(f"Configured Port: {HOST_PORT}")
print(f"Target Socket test: {TARGET_SOCKET_HOST}:{TARGET_SOCKET_PORT}")

# Global state to store socket test results
socket_test_results = {
    "status": "Not run yet",
    "latency_ms": 0.0,
    "last_check": ""
}

# -------------------------------------------------------------
# Socket Connectivity Test function
# -------------------------------------------------------------
def test_socket_connectivity(host=TARGET_SOCKET_HOST, port=TARGET_SOCKET_PORT, timeout=3):
    """Attempts to open a socket connection to target host and port to measure connectivity."""
    start_time = time.time()
    try:
        # Create a socket object
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        # Connect to the target
        s.connect((host, port))
        latency = (time.time() - start_time) * 1000
        s.close()
        
        status_msg = f"Successfully connected to socket {host}:{port}"
        print(f"📡 [Socket Check] {status_msg} in {latency:.2f}ms")
        
        socket_test_results["status"] = "Connected Successfully"
        socket_test_results["latency_ms"] = round(latency, 2)
        socket_test_results["last_check"] = time.strftime("%Y-%m-%d %H:%M:%S")
        return True
    except Exception as e:
        # Handle cases where user tests 8.8.8.8 on port 80 (DNS IP with no HTTP server)
        error_context = str(e)
        if host == "8.8.8.8" and port == 80:
            error_context += " (Note: 8.8.8.8 is a DNS resolver. It listens on Port 53, not HTTP Port 80. Try port 53 for successful handshake!)"
        
        status_msg = f"Failed connection to {host}:{port} - {error_context}"
        print(f"❌ [Socket Check] {status_msg}")
        
        socket_test_results["status"] = f"Failed: {error_context}"
        socket_test_results["latency_ms"] = -1.0
        socket_test_results["last_check"] = time.strftime("%Y-%m-%d %H:%M:%S")
        return False

# Periodically run socket checks in the background
def socket_monitor_thread():
    while True:
        test_socket_connectivity(lyrr
        time.sleep(15)

# -------------------------------------------------------------
# HTTP server listening on 0.0.0.0:5000
# -------------------------------------------------------------
class SimpleHTTPRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Allow health checks or browser queries
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        
        import json
        response_data = {
            "status": "active",
            "server_running_on": f"{HOST_IP}:{HOST_PORT}",
            "socket_connection_test": {
                "target": f"{TARGET_SOCKET_HOST}:{TARGET_SOCKET_PORT}",
                "result": socket_test_results["status"],
                "latency_ms": socket_test_results["latency_ms"],
                "last_check": socket_test_results["last_check"]
            }
        }
        self.wfile.write(json.dumps(response_data, indent=4).encode('utf-8'))

def start_http_server():
    try:
        httpd = HTTPServer((HOST_IP, HOST_PORT), SimpleHTTPRequestHandler)
        print(f"🚀 [HTTP Server] Listening on http://{HOST_IP}:{HOST_PORT}")
        httpd.serve_forever()
    except Exception as e:
        print(f"❌ [HTTP Server] Failed to start on {HOST_IP}:{HOST_PORT} - {str(e)}")

# Start background HTTP Server and Socket Monitor threads
threading.Thread(target=start_http_server, daemon=True).start()
threading.Thread(target=socket_monitor_thread, daemon=True).start()

# Give threads a second to boot up and perform initial test
time.sleep(1)

# -------------------------------------------------------------
# Telebot Setup & Polling
# -------------------------------------------------------------
if BOT_TOKEN == "YOUR_CHILD_BOT_TOKEN_HERE":
    print("Warning: Please set a valid BOT_TOKEN to make the bot respond in Telegram!")
    print("Running in background server mode. Polling for connections...")
    # Keep main thread alive in standalone server mode
    while True:
        time.sleep(10)
else:
    # Initialize and run Telebot
    bot = telebot.TeleBot(BOT_TOKEN)

    @bot.message_handler(commands=['start', 'help'])
    def send_welcome(message):
        bot.reply_to(message, "👋 Hello! I am a child bot hosted automatically inside the Bot Deployer platform!\n\nUse /ping or /socket to test me.")

    @bot.message_handler(commands=['ping'])
    def send_ping(message):
        start_time = time.time()
        try:
            res = requests.get("https://api.github.com")
            latency = round((time.time() - start_time) * 1000, 2)
            bot.reply_to(message, f"🏓 Pong! Web request latency: {latency}ms")
        except Exception as e:
            bot.reply_to(message, f"🏓 Pong! Network check failed: {str(e)}")

    @bot.message_handler(commands=['socket'])
    def send_socket_status(message):
        # Run socket connection test on-demand
        success = test_socket_connectivity()
        status_text = "✅ SUCCESS" if success else "❌ FAILED"
        bot.reply_to(
            message,
            f"📡 *Socket Connection Status Check*\n"
            f"• Target: `{TARGET_SOCKET_HOST}:{TARGET_SOCKET_PORT}`\n"
            f"• Result: *{status_text}*\n"
            f"• Latency: `{socket_test_results['latency_ms']}ms`\n"
            f"• Check Time: `{socket_test_results['last_check']}`",
            parse_mode="Markdown"
        )

    @bot.message_handler(func=lambda message: True)
    def echo_all(message):
        bot.reply_to(message, f"Echo: {message.text}")

    print("Child bot started polling successfully!")
    try:
        print("Removing existing webhook...")
        bot.delete_webhook()
        print("Webhook removed successfully!")
    except Exception as e:
        print(f"Warning: Could not delete webhook: {e}")
    bot.infinity_polling()
