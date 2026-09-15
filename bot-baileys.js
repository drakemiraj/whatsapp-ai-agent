require('dotenv').config();

// Global crash protection so the bot never terminates
process.on('uncaughtException', (err) => {
  console.warn('🛡️ [UncaughtException Handled]:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.warn('🛡️ [UnhandledRejection Handled]:', reason?.message || reason);
});

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const { generateAIResponse } = require('./agent');
const { initStorage } = require('./leadsManager');
const { resolveRealPhoneNumber, updateContact, getContact, getBestContactName } = require('./contactsManager');
const config = require('./config.json');

// Auto-acquire Termux Wake-Lock on start so phone CPU never sleeps
try {
  exec('termux-wake-lock', (err) => {
    if (!err) console.log('🔋 [Auto Wake-Lock] Phone CPU Wake-Lock active 24/7 (Never sleeps)');
  });
} catch (e) {}

console.log('================================================================');
console.log('🚀 Starting WhatsApp Business AI Agent - Riya (Hem Singh Sir / Darkemi Digital Agency)');
console.log('⚡ 24/7 Unstoppable Master Agent + Auto-Restart + Heartbeat Active');
console.log('================================================================');

const QR_HTML_PATH = path.join(__dirname, 'qr.html');
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.jpg');
const INBOX_MEDIA_DIR = path.join(__dirname, 'inbox_media');

if (!fs.existsSync(INBOX_MEDIA_DIR)) {
  fs.mkdirSync(INBOX_MEDIA_DIR, { recursive: true });
}

// Map to track paused chats: remoteJid -> expiryTimestamp (or Infinity)
const pausedChats = new Map();

// Track alerted phone numbers so we don't spam duplicate alerts for the same customer
const alertedCustomers = new Set();

let browserOpened = false;

async function sendHotLeadAlert(sock, customerPhone, customerName, cityLocation, serviceOrModel, budgetOrPrice, dealStatus, finalRemarks) {
  // Allow alert if customer name, location, or status updates
  const alertFingerprint = `${customerPhone}_${customerName}_${cityLocation}_${dealStatus}`;
  if (alertedCustomers.has(alertFingerprint)) return;
  alertedCustomers.add(alertFingerprint);

  const alertText = 
    `🚨 *[नया हॉट लीड अलर्ट - Darkemi Agency]*\n\n` +
    `• 👤 *ग्राहक का नाम:* ${customerName}\n` +
    `• 📞 *मोबाइल नंबर:* ${customerPhone}\n` +
    `• 📍 *शहर / लोकेशन:* ${cityLocation}\n` +
    `• 💼 *सर्विस / काम:* ${serviceOrModel}\n` +
    `• 💰 *बजट / पैकेज:* ${budgetOrPrice}\n` +
    `• 📌 *स्टेटस:* *${dealStatus}*\n` +
    `• 📝 *रिमार्क्स:* ${finalRemarks}\n\n` +
    `⚡ ग्राहक आपकी कॉल का इंतज़ार कर रहा है!`;

  console.log(`\n📢 [हॉट लीड ट्रिगर] ${customerName} (${customerPhone}) - ${cityLocation} | ${dealStatus}`);

  // 1. Send to "Message Yourself" (You) on the connected WhatsApp Business number
  try {
    const myPhone = (sock.user?.id || '').split(':')[0].replace(/[^0-9]/g, '');
    if (myPhone) {
      const mySelfJid = `${myPhone}@s.whatsapp.net`;
      await sock.sendMessage(mySelfJid, { text: alertText });
      console.log(`📲 [हॉट लीड अलर्ट -> आपके खुद के WhatsApp (Message Yourself) पर भेजा गया] -> ${myPhone}`);
    }
    // Also send to full user JID if different
    if (sock.user?.id && !sock.user.id.startsWith(myPhone + '@')) {
      await sock.sendMessage(sock.user.id, { text: alertText }).catch(() => {});
    }
  } catch (err) {
    console.warn('Notice: Could not send self alert:', err.message);
  }

  // 2. Auto-forward to any WhatsApp Group named "DRAKEMI LEADS", "Leads", etc.
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [gid, gdata] of Object.entries(groups)) {
      const subject = (gdata.subject || '').toLowerCase();
      if (subject.includes('lead') || subject.includes('लीड') || subject.includes('drakemi')) {
        await sock.sendMessage(gid, { text: alertText });
        console.log(`📢 [हॉट लीड अलर्ट -> ग्रुप "${gdata.subject}"] भेजा गया`);
      }
    }
  } catch (groupErr) {}

  // 3. Send to calling phone WhatsApp if registered
  const ownerNumber = (config.ownerPhone || '7014997951').replace(/[^0-9]/g, '');
  if (ownerNumber) {
    const ownerJid = `91${ownerNumber.slice(-10)}@s.whatsapp.net`;
    try {
      await sock.sendMessage(ownerJid, { text: alertText });
      console.log(`📲 [हॉट लीड अलर्ट -> ओनर नंबर पर भेजा गया] -> ${ownerJid}`);
    } catch (err) {}
  }
}

async function startBot() {
  initStorage();

  const authDir = path.join(__dirname, 'baileys_auth');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1017531287], isLatest: true }));

  console.log(`📡 Connecting to WhatsApp (Protocol v${version.join('.')}, latest: ${isLatest})...`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    generateHighQualityLinkPreview: true
  });

  // 8-Digit Pairing Code (Phone पर बिना QR स्कैन के 5 सेकंड में लिंक करने के लिए)
  if (!state.creds.registered) {
    const rawNumber = (config.botPhone || config.ownerPhone || '6377768475').replace(/[^0-9]/g, '');
    const phoneNumber = rawNumber.length === 10 ? `91${rawNumber}` : rawNumber;
    setTimeout(async () => {
      try {
        const rawCode = await sock.requestPairingCode(phoneNumber);
        const formattedCode = rawCode ? (rawCode.match(/.{1,4}/g)?.join('-') || rawCode) : rawCode;
        console.log('\n=============================================================');
        console.log(`📲 WhatsApp 8-अंकों का पेयरिंग कोड: 👉  ${formattedCode}  👈`);
        console.log('👉 अपने WhatsApp Business पर जाएँ -> Three dots (⋮) -> Linked Devices');
        console.log('👉 "Link a Device" -> नीचे "Link with phone number instead" पर टैप करें');
        console.log(`👉 यह 8 अंकों का कोड [ ${formattedCode} ] भरें! (60 सेकंड में)`);
        console.log('=============================================================\n');
      } catch (err) {
        console.warn('Pairing code notice:', err.message);
      }
    }, 2500);
  }

  sock.ev.on('creds.update', saveCreds);

  // Sync Phonebook Contacts from WhatsApp
  sock.ev.on('messaging-history.set', ({ contacts }) => {
    if (contacts && Array.isArray(contacts)) {
      for (const c of contacts) {
        if (c.id) updateContact(c.id, { name: c.name, notify: c.notify });
      }
      console.log(`📇 [फोनबुक सिंक] ${contacts.length} कॉन्टैक्ट्स सुरक्षित किए गए।`);
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    if (contacts && Array.isArray(contacts)) {
      for (const c of contacts) {
        if (c.id) updateContact(c.id, { name: c.name, notify: c.notify });
      }
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    if (updates && Array.isArray(updates)) {
      for (const u of updates) {
        if (u.id) updateContact(u.id, { name: u.name, notify: u.notify });
      }
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=============================================================');
      console.log('📲 कृपया अपने WhatsApp Business से यह QR Code स्कैन करें:');
      console.log('(WhatsApp खोलें -> थ्री डॉट्स -> Linked Devices -> Link a Device)');
      console.log('=============================================================\n');
      qrcode.generate(qr, { small: true });

      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=15&data=${encodeURIComponent(qr)}`;
      const htmlContent = `
<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <title>WhatsApp Business AI Agent - QR Code</title>
  <meta http-equiv="refresh" content="20">
  <style>
    body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 30px; border-radius: 20px; text-align: center; max-width: 420px; border: 1px solid #334155; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h2 { color: #38bdf8; margin: 0 0 10px 0; font-size: 22px; }
    .qr-box { background: white; padding: 15px; border-radius: 12px; display: inline-block; margin: 15px 0; }
    .qr-box img { width: 280px; height: 280px; display: block; }
    ol { text-align: left; background: #0f172a; padding: 15px 25px; border-radius: 10px; font-size: 14px; color: #cbd5e1; line-height: 1.6; }
    .badge { background: #10b981; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; display: inline-block; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">DRAKEMI AI Assistant</span>
    <h2>WhatsApp Business से स्कैन करें</h2>
    <div class="qr-box">
      <img src="${qrImageUrl}" alt="QR Code" />
    </div>
    <ol>
      <li>अपने मोबाइल में <b>WhatsApp Business</b> खोलें।</li>
      <li>ऊपर <b>तीन डॉट्स (⋮)</b> -> <b>Linked Devices</b> दबाएं।</li>
      <li><b>Link a Device</b> दबाकर इस कोड को स्कैन करें।</li>
    </ol>
  </div>
</body>
</html>`;
      fs.writeFileSync(QR_HTML_PATH, htmlContent, 'utf-8');

      if (!browserOpened) {
        browserOpened = true;
        exec(`start "" "${QR_HTML_PATH}"`);
      }
    }

    if (connection === 'close') {
      if (global.heartbeatTimer) clearInterval(global.heartbeatTimer);
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ [24/7 Self-Healing] कनेक्शन ड्रॉप हुआ (${statusCode}), 2 सेकंड में स्वतः पुनः कनेक्ट हो रहा है...`);
      if (shouldReconnect) {
        setTimeout(startBot, 2000);
      } else {
        console.log('❌ डिवाइस लॉगआउट हो गया है। 10 सेकंड में ऑटो-रिकवर की कोशिश जारी...');
        setTimeout(startBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('\n=============================================================');
      console.log('✅ WhatsApp Business AI Agent (रिया) सफलतापूर्वक कनेक्ट हो गया है!');
      console.log('🛡️ 24/7 Unstoppable Engine + Auto-Heartbeat (30s) + विज़न AI एक्टिव');
      console.log('=============================================================\n');

      // 24/7 Keep-Alive Heartbeat Ping: Prevents mobile carrier / WiFi idle socket drops
      if (global.heartbeatTimer) clearInterval(global.heartbeatTimer);
      global.heartbeatTimer = setInterval(async () => {
        try {
          if (sock && sock.ws && sock.ws.isOpen) {
            await sock.sendPresenceUpdate('available');
          }
        } catch (e) {}
      }, 30000);

      const successHtml = `
<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <title>Connected</title>
  <style>
    body { font-family: sans-serif; background: #064e3b; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
    .box { background: #065f46; padding: 40px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.4); max-width: 450px; }
    h1 { color: #34d399; font-size: 26px; }
    p { font-size: 16px; line-height: 1.6; color: #a7f3d0; }
  </style>
</head>
<body>
  <div class="box">
    <h1>🎉 WhatsApp Business एजेंट कनेक्ट हो गया!</h1>
    <p>आपका <b>DRAKEMI AI Assistant (रिया)</b> अब फोनबुक रिकग्निशन मोड में सक्रिय है।</p>
    <p style="font-size: 13px; color: #6ee7b7;">आप इस ब्राउज़र टैब को बंद कर सकते हैं।</p>
  </div>
</body>
</html>`;
      fs.writeFileSync(QR_HTML_PATH, successHtml, 'utf-8');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') continue;

      // Always resolve to clean real phone number
      const realPhone = resolveRealPhoneNumber(remoteJid);
      const pushName = msg.pushName || '';

      if (pushName) {
        updateContact(remoteJid, { pushName });
      }

      const rawText = (msg.message?.conversation || 
                       msg.message?.extendedTextMessage?.text || 
                       msg.message?.imageMessage?.caption || '').trim();
      const lowerText = rawText.toLowerCase();

      // =========================================================================
      // 1. HUMAN TAKEOVER: Check if the message is sent by HEM SINGH SIR (fromMe)
      // =========================================================================
      if (msg.key.fromMe) {
        // A. Explicit Stop Command
        const isStopCommand = 
          lowerText === 'stop riya' || 
          lowerText === '#stop' || 
          lowerText === 'रिया रुको' || 
          lowerText === 'स्टॉप रिया' || 
          lowerText === 'pause riya' || 
          lowerText === 'रुको रिया';

        if (isStopCommand) {
          pausedChats.set(remoteJid, Infinity);
          pausedChats.set(realPhone, Infinity);
          console.log(`\n⏸️ [मैनुअल स्टॉप] हेम सिंह सर ने चैट ${realPhone} में रिया को रोक दिया है। (#start या 'continue riya' बोलने तक शांत रहेगी)`);
          continue;
        }

        // B. Explicit Resume Command
        const isStartCommand = 
          lowerText === 'continue riya' || 
          lowerText === '#start' || 
          lowerText === 'चालू रिया' || 
          lowerText === 'रिया शुरू करो' || 
          lowerText === 'resume riya' || 
          lowerText === 'शुरू रिया';

        if (isStartCommand) {
          pausedChats.delete(remoteJid);
          pausedChats.delete(realPhone);
          console.log(`\n▶️ [मैनुअल स्टार्ट] हेम सिंह सर ने चैट ${realPhone} में रिया को फिर से एक्टिव कर दिया है।`);
          continue;
        }

        // C. Normal Manual Message by Hem Singh Sir -> Auto-pause Riya for 5 Minutes!
        const autoPauseExpiry = Date.now() + (5 * 60 * 1000); // 5 minutes
        pausedChats.set(remoteJid, autoPauseExpiry);
        pausedChats.set(realPhone, autoPauseExpiry);
        console.log(`\n👤 [हेम सिंह सर बात कर रहे हैं] चैट ${realPhone} पर रिया अगले 5 मिनट के लिए शांत रहेगी...`);
        continue;
      }

      // =========================================================================
      // 2. INCOMING CUSTOMER MESSAGE: Check if this chat is paused
      // =========================================================================
      const isGreetingOrTest = ['hi', 'hello', 'hey', 'test', 'namaste', '#start', 'continue riya', 'चालू रिया', 'शुरू रिया', 'start'].includes(lowerText);
      if (isGreetingOrTest) {
        pausedChats.delete(remoteJid);
        pausedChats.delete(realPhone);
      }

      const pauseUntil = pausedChats.get(remoteJid) || pausedChats.get(realPhone);
      if (pauseUntil) {
        if (pauseUntil === Infinity || Date.now() < pauseUntil) {
          const remainingSec = pauseUntil === Infinity ? 'स्थाई रोक (जब तक #start न बोलें)' : `${Math.round((pauseUntil - Date.now()) / 1000)}s`;
          console.log(`🤫 [चैट पॉज है - कोई AI रिप्लाई नहीं] ${realPhone} (पॉज: ${remainingSec}) - हेम सिंह सर बात कर रहे हैं`);
          continue; // DO NOT REPLY - Let Hem Singh Sir handle it!
        } else {
          // 5 minutes expired! Automatically unpause
          pausedChats.delete(remoteJid);
          pausedChats.delete(realPhone);
          console.log(`⏰ [5 मिनट का विराम समाप्त] चैट ${realPhone} पर रिया पुनः एक्टिव है।`);
        }
      }

      const isImage = !!msg.message?.imageMessage;
      const isAudio = !!msg.message?.audioMessage;
      let mediaData = null;

      // Handle Image Media
      if (isImage) {
        console.log(`\n📷 [फोटो प्राप्त] ${realPhone} - डाउनलोड व विज़न विश्लेषण जारी...`);
        try {
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
          );
          if (buffer) {
            const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
            mediaData = { type: 'image', buffer, mimeType };

            const safeName = `${Date.now()}_${realPhone.replace(/[^0-9]/g, '')}.jpg`;
            fs.writeFileSync(path.join(INBOX_MEDIA_DIR, safeName), buffer);
            console.log(`💾 [फोटो सुरक्षित की गई] -> inbox_media/${safeName}`);
          }
        } catch (mediaErr) {
          console.error('Error downloading image:', mediaErr.message);
        }
      }

      // Handle Audio Media
      if (isAudio) {
        console.log(`\n🎙️ [वॉइस नोट प्राप्त] ${realPhone} - ऑडियो विश्लेषण जारी...`);
        try {
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
          );
          if (buffer) {
            const mimeType = msg.message.audioMessage.mimetype || 'audio/ogg; codecs=opus';
            mediaData = { type: 'audio', buffer, mimeType };
          }
        } catch (audioErr) {
          console.error('Error downloading voice note:', audioErr.message);
        }
      }

      if (!rawText && !mediaData) continue;

      const contactName = getBestContactName(remoteJid) || pushName;
      console.log(`\n📩 [ग्राहक का संदेश] ${contactName ? `"${contactName}"` : 'ग्राहक'} (${realPhone}): "${rawText}" ${mediaData ? `[${mediaData.type}]` : ''}`);

      // Fast Logo Request
      if ((lowerText.includes('logo') || lowerText.includes('लोगो')) && (lowerText.includes('bhejo') || lowerText.includes('send') || lowerText.includes('dikhao') || lowerText.includes('dekho'))) {
        if (fs.existsSync(LOGO_PATH)) {
          await sock.sendMessage(remoteJid, {
            image: fs.readFileSync(LOGO_PATH),
            caption: '✨ यह हमारी आधिकारिक एजेंसी "Darkemi Digital Agency by Hem Singh Sir" का लोगो है।'
          });
          console.log(`📤 [लोगो भेजा गया] -> ${realPhone}`);
          continue;
        }
      }

      // Fast typing indicator
      sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});

      // Generate AI Response with Riya
      const aiResponse = await generateAIResponse(remoteJid, rawText, mediaData);

      // Send reply safely
      try {
        await sock.sendMessage(remoteJid, { text: aiResponse });
        sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        console.log(`📤 [रिया का रिप्लाई भेजा] -> ${realPhone}: "${aiResponse}"`);
      } catch (sendErr) {
        console.warn(`⚠️ [संदेश भेजने में त्रुटि] -> ${realPhone}:`, sendErr.message);
      }

      // Check if this lead needs an alert to Hem Singh Sir's personal WhatsApp
      try {
        const leadsFile = path.join(__dirname, 'leads.json');
        if (fs.existsSync(leadsFile)) {
          const leadsData = JSON.parse(fs.readFileSync(leadsFile, 'utf-8'));
          const thisLead = leadsData.find(l => l.phoneNumber === realPhone);
          if (thisLead && (thisLead.dealStatus === 'Ready for Call' || thisLead.dealStatus === 'Deal Closed / Booked')) {
            sendHotLeadAlert(
              sock,
              realPhone,
              thisLead.customerName || 'ग्राहक',
              thisLead.cityLocation || 'स्थान N/A',
              thisLead.serviceOrModel || 'डील',
              thisLead.budgetOrPrice || 'N/A',
              thisLead.dealStatus,
              thisLead.finalRemarks || ''
            ).catch(() => {});
          }
        }
      } catch (err) {}
    }
  });
}

// Start lightweight health check HTTP server for Cloud Hosting (Render, Railway, etc.)
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/qr' && fs.existsSync(QR_HTML_PATH)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(QR_HTML_PATH));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <div style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #0b141a; color: #fff; min-height: 100vh;">
      <h1 style="color: #25d366;">🚀 Darkemi Digital Agency AI Agent (रिया)</h1>
      <p style="font-size: 18px; color: #aebac1;">Hem Singh Sir's Executive WhatsApp Assistant is <b>Active & Running 24/7</b>.</p>
      <p style="margin-top: 30px;"><a href="/qr" style="background: #25d366; color: #000; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">View WhatsApp QR Code</a></p>
    </div>
  `);
});
server.listen(PORT, () => {
  console.log(`🌐 Cloud Health-Check HTTP Server listening on port ${PORT}`);
});

startBot().catch(err => console.error('Fatal Bot Error:', err));
