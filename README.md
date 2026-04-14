# Stremio-Jellyfin Bridge

A lightweight, robust Node.js addon that seamlessly integrates your local Jellyfin server into Stremio. Designed for secure, local network streaming, this bridge brings your personal media library directly into the Stremio UI with full metadata, native subtitles, and automatic local HTTPS support.

## ✨ Features

* 🛡️ **100% Local Traffic:** No port-forwarding, reverse proxies, or exposing your Jellyfin server to the internet. The bridge runs entirely within your LAN, keeping your media secure and private.
* 🎬 **Full Library Integration:** Browse your Jellyfin Movies and TV Shows directly within Stremio's Home and Discover tabs (or easily hide them and rely purely on search).
* 📺 **Series Support:** Season and episode resolution. Automatically maps local episodes to Stremio's UI, pulling native thumbnails and falling back to the show's backdrop when needed.
* 🚀 **Smart Playback Options:** Offers both **Direct Play** (raw, uncompressed file delivery for maximum quality on capable devices like the NVIDIA Shield) and **Transcode** (HLS fallback for universal compatibility).
* 📝 **Native Subtitle Injection:** Automatically searches your Jellyfin library, extracts attached `.srt` or embedded subtitle tracks, and pipes them directly into Stremio's video player.
* 🖼️ **Dynamic Image Proxying:** Features a custom, memory-efficient Express proxy that catches Jellyfin image URLs mid-air, stripping restrictive `Content-Disposition: attachment` security headers so posters and backgrounds render natively in Stremio.
* 🔒 **Zero-Config Local HTTPS:** Built-in dynamic IP detection and automatic wildcard SSL certificate generation (via `local-ip.medicmobile.org`). This satisfies Stremio's strict mixed-content security requirements, allowing seamless installation across Windows PCs, Web interfaces, and Android TV environments.

## 📋 Prerequisites

* A running **Jellyfin Server** (v10.8.0 or higher recommended) accessible on your local network.
* An API Key generated from your Jellyfin Dashboard.
* **For Docker Installation (Recommended):** Docker and Docker Compose installed on a Linux host (required for host networking).
* **For Manual Installation:** **Node.js** (v20.12.0 or higher required).

## 🚀 Installation & Setup

First, clone the repository to your host machine
```bash
git clone <your-repo-url>
cd stremio-jellyfin-bridge
npm install
```

Next, configure your environment variables by copying the example file:
```bash
cp .env.example .env
nano .env
```

Populate the `.env` file with your details:
```env
# Your local Jellyfin Server URL
JELLYFIN_URL=http://192.168.X.X:8096

# API Key generated from Jellyfin Dashboard -> Advanced -> API Keys
JELLYFIN_API_KEY=your_api_key_here

# The specific Jellyfin user the bridge will act as
JELLYFIN_USER_NAME=your_username

# The default language code for subtitles files without proper naming convention
JELLYFIN_DEFAULT_EXT_SUBS_LANG=eng

# Ports for the Node server
PORT=7000
HTTPS_PORT=7001

# Set to 'false' to hide Jellyfin rows from Stremio's Discover page
SHOW_CATALOG=true
```


Choose **one** of the following deployment methods:

### 🐳 Option 1: Deploying with Docker (Recommended)

Deploying with Docker ensures all dependencies (and Node versions) are perfectly isolated and guarantees the bridge automatically restarts with your server. 

*(Note: Because this relies on `network_mode: "host"` to dynamically generate SSL certificates for your local IP, this deployment is optimized for Linux environments).*

1. Build and start the container in detached mode:
   ```bash
   docker compose up -d --build
   ```

2. Check the logs to verify a successful boot and get your installation URL:
   ```bash
   docker logs -f stremio-jellyfin-bridge
   ```
   *(Press `Ctrl+C` to exit the logs).*

### 💻 Option 2: Manual Native Installation

If you prefer to run the Node.js application directly on your host machine without containerization.

1. Install the required Node dependencies:
   ```bash
   npm install
   ```
   *(Note: This will automatically run a post-install script that applies a necessary patch to the Stremio Addon SDK).*

2. Start the server:
   ```bash
   npm start
   ```
  *(Wait a moment for the server to resolve your local IP and generate the SSL certificates).*


## 📺 Install in Stremio
   Look at your terminal output for the secure URL, which will look something like this:
   ```
   https://192-168-x-x.local-ip.medicmobile.org:7001/manifest.json
   ```
   Copy this URL, paste it into Stremio's Addon Search Bar, and click **Install**.

## 🏗️ Architecture Notes

* **The SDK Patch:** The bridge automatically patches Stremio's built-in SDK during `npm install` to expose the underlying Express `app` object. This allows the bridge to mount the custom image proxy directly onto the same port as the Stremio manifest handlers.
* **The Proxy Pipeline:** To prevent Jellyfin from forcing image downloads on Stremio clients, the bridge intercepts all `/Images/Primary` requests. It streams the raw binary data directly to the client while actively stripping the UI attachment headers. No files are saved to the bridge's local disk.
* **Network Binding:** The server dynamically scans available network interfaces on boot, binding the HTTPS domain specifically to your primary IPv4 LAN address. This ensures the addon routes correctly whether requested by a local desktop or a smart TV over Wi-Fi.

## 🛠️ Troubleshooting: Stremio Fails to Install the Addon (`NXDOMAIN` Error)

If you paste your `https://...local-ip.medicmobile.org:7001/manifest.json` URL into Stremio and it fails to load, or your web browser shows a `DNS_PROBE_FINISHED_NXDOMAIN` error, your local network is blocking the resolution.

**Why this happens:** This is a security feature built into most modern routers called **DNS Rebinding Protection**. When your browser asks the public internet to resolve the URL, the DNS server correctly replies with your private IP. However, your router sees a public domain trying to route to a private network, assumes it is a malicious attack, and intentionally drops the response—making it look like the domain doesn't exist (`NXDOMAIN`).

To fix this, you must tell your system that this specific local routing is safe.

### Solution 1: Add to your Router's Hosts File (Recommended)
If you have access to your home router's advanced settings (especially on custom firmware like OpenWrt, DD-WRT, or OPNsense), you can resolve this for your entire network at once.
* Access your router's `/etc/hosts` file (or local DNS records section).
* Add a direct mapping for your bridge's IP and URL. For example:
  `192.168.1.11 192-168-1-11.local-ip.medicmobile.org`
* Save and restart your router's DNS service.

### Solution 2: Whitelist the Domain in your Router
Alternatively, you can whitelist the domain in your router's DNS Rebinding protection settings.
* **OpenWrt (Dnsmasq):** Add `local-ip.medicmobile.org` to your domain whitelist.
* **pfSense / OPNsense:** Add `server: private-domain: "local-ip.medicmobile.org"` to your custom DNS Resolver options.

### Solution 3: Edit your Device's Hosts File
If you cannot modify your home router, you can map the IP directly on the device running Stremio.
* **Windows:** Open Notepad as Administrator, edit `C:\Windows\System32\drivers\etc\hosts`, and add the mapping line from Solution 1.
* **Mac/Linux:** Open your terminal, run `sudo nano /etc/hosts`, and add the exact same mapping line.

### Solution 4: Change DNS on Android TV / NVIDIA Shield (No Root Required)
If you are using a smart TV or NVIDIA Shield and cannot change your router's settings, your device is likely using your ISP's default DNS, which aggressively blocks local IP routing. 

You can bypass this by changing your Android TV's network settings to use Google's Public DNS, which allows these local mappings to resolve properly.

1. On your Android TV/Shield, go to **Settings** -> **Network & Internet**.
2. Select your currently connected Wi-Fi or Ethernet network.
3. Scroll down and select **IP settings**.
4. Change it from **DHCP** to **Static**.
5. Leave the IP Address and Gateway exactly as they are (just click Next through them).
6. When prompted for **DNS 1**, enter `8.8.8.8`.
7. When prompted for **DNS 2**, enter `8.8.4.4`.
8. Save the settings, restart Stremio, and paste your installation URL again.
