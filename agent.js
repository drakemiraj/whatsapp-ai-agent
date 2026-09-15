const { SYSTEM_PROMPT, CLINIC_DEMO_PROMPT, GYM_DEMO_PROMPT, REAL_ESTATE_DEMO_PROMPT } = require('./prompts');
const config = require('./config.json');
const { saveLead, getLeadStats } = require('./leadsManager');
const { resolveRealPhoneNumber, getContact, getBestContactName, updateContact } = require('./contactsManager');

// In-memory conversation history per customer and mode
const userSessions = new Map();

// Track abuse count per customer for 3-tier de-escalation
const abuseCountMap = new Map();

// Per-chat mode state map: phoneNumber -> { mode: 'AGENCY' | 'CLINIC' | 'GYM' | 'REAL_ESTATE', lastActive: Date.now(), previousDemo: '' }
const chatModeMap = new Map();

function getChatState(phoneNumber) {
  let state = chatModeMap.get(phoneNumber);
  if (!state) {
    state = { mode: 'AGENCY', lastActive: Date.now(), previousDemo: '' };
    chatModeMap.set(phoneNumber, state);
    return state;
  }
  
  // TRIGGER B: Inactivity Reset (5 minutes = 300,000 ms)
  // If demo mode has been idle for > 5 minutes, silently reset back to AGENCY mode
  if (state.mode !== 'AGENCY') {
    const idleTime = Date.now() - state.lastActive;
    if (idleTime > 5 * 60 * 1000) {
      console.log(`⏱️ [Demo Inactivity Reset] Chat ${phoneNumber} idle for ${Math.round(idleTime / 1000)}s -> silently reset to AGENCY mode`);
      state.previousDemo = state.mode;
      state.mode = 'AGENCY';
      state.lastActive = Date.now();
      chatModeMap.set(phoneNumber, state);
    }
  }
  return state;
}

function setChatMode(phoneNumber, mode, previousDemo = '') {
  chatModeMap.set(phoneNumber, {
    mode,
    lastActive: Date.now(),
    previousDemo: previousDemo || ''
  });
}

function getSessionKey(phoneNumber, mode = 'AGENCY') {
  return mode === 'AGENCY' ? phoneNumber : `${phoneNumber}__${mode}`;
}

function getSession(phoneNumber, mode = 'AGENCY') {
  const key = getSessionKey(phoneNumber, mode);
  if (!userSessions.has(key)) {
    userSessions.set(key, []);
  }
  return userSessions.get(key);
}

function clearSession(phoneNumber, mode = 'AGENCY') {
  const key = getSessionKey(phoneNumber, mode);
  userSessions.set(key, []);
}

function recordMessage(phoneNumber, role, content, mode = 'AGENCY') {
  const history = getSession(phoneNumber, mode);
  history.push({ role, content });
  const maxTurns = config.maxMemoryTurns || 20;
  if (history.length > maxTurns) {
    history.splice(0, history.length - maxTurns);
  }
}

// Get current Indian Standard Time (IST) details
function getIndiaTimeInfo() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  // Day is 6:00 AM (06:00) to 7:00 PM (18:59:59)
  const isDayTime = hour >= 6 && hour < 19;
  return {
    hour,
    minute,
    isDayTime,
    timeStr: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} IST`
  };
}

// Extract declared customer name from message
function extractDeclaredName(text) {
  if (!text) return null;
  const t = text.trim();
  const patterns = [
    /(?:mera\s+naam|my\s+name|naam|name)\s+(?:hai\s+|is\s+)?([a-zA-Z\u0900-\u097F]{2,20})/i,
    /(?:main|mai|m)\s+([a-zA-Z\u0900-\u097F]{2,20})\s+(?:bol\s+raha|bol\s+rahi)/i,
    /^([a-zA-Z\u0900-\u097F]{2,20})\s+(?:bol\s+raha|bol\s+rahi)/i,
    /^i\s+am\s+([a-zA-Z\u0900-\u097F]{2,20})/i
  ];
  for (const pat of patterns) {
    const m = t.match(pat);
    if (m && m[1]) {
      const cand = m[1].trim();
      const candLower = cand.toLowerCase();
      const blacklist = ['raj', 'thakur', 'samajhti', 'maine', 'mene', 'main', 'mujhe', 'hum', 'sir', 'bhai', 'drakemi', 'darkemi', 'riya', 'kuch', 'nahi', 'nhi', 'kya', 'love', 'good', 'night', 'sorry', 'madam', 'number', 'galt', 'ha', 'haan', 'ok', 'here', 'batayein', 'kaun', 'alwar', 'delhi', 'jaipur'];
      if (!blacklist.includes(candLower)) {
        return cand;
      }
    }
  }
  return null;
}

// Ultra-fast, high-quota models list
const MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash'
];

async function callGeminiWithFailover(apiKey, contents) {
  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.25,
            maxOutputTokens: 1000
          }
        }),
        signal: AbortSignal.timeout(8000)
      });

      if (response.ok) {
        const data = await response.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const fullText = parts.map(p => p.text || '').join('').trim();
        if (fullText) {
          return fullText;
        }
      } else {
        const errJson = await response.json().catch(() => ({}));
        console.warn(`[Model ${model} Warning] Status: ${response.status} - ${errJson?.error?.message || 'Error'}. Trying next model...`);
      }
    } catch (err) {
      console.warn(`[Model ${model} Exception] ${err.message}. Trying next model...`);
    }
  }
  return null;
}

// Extract Layer 1 JSON and separate customer-facing text
function parseTwoLayerResponse(rawAiText) {
  let analysis = null;
  let cleanText = rawAiText || '';

  const jsonMatch = rawAiText.match(/<!--INTERNAL_ANALYSIS\s*([\s\S]*?)\s*-->/i);
  if (jsonMatch && jsonMatch[1]) {
    try {
      analysis = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      analysis = null;
    }
    // Strip JSON block completely so customer NEVER sees it
    cleanText = rawAiText.replace(/<!--INTERNAL_ANALYSIS[\s\S]*?-->/gi, '').trim();
  }

  // Fallback: strip any stray markdown json code blocks if AI leaked them
  cleanText = cleanText.replace(/```json[\s\S]*?```/gi, '').trim();

  return { analysis, cleanText };
}

// Full Official Darkemi Service List
const FULL_SERVICE_LIST_TEXT = 
`जी 😊 Darkemi Digital Agency में हमारी प्रमुख services हैं:

🤖 AI Agent Development
💻 Custom Software Development
🎨 Logo Design
💌 Digital Invitation Card
💍 Marriage Biodata
📄 CV / Resume
💼 Business Card Design
📊 PPT Design
🖼️ Poster Design
📸 Product Photo / Product Poster
🎬 UGC Ads / AI Ads

इनमें से आपको किस तरह का काम करवाना है? आप अपनी requirement बता दीजिए, मैं आपको उसके अनुसार details और pricing बता सकती हूँ।`;

// Full Official Darkemi Price List
const FULL_PRICE_LIST_TEXT = 
`जी 😊 Darkemi की current pricing:

🤖 AI Agent Development
• Normal — ₹1,499
• Premium — ₹19,900

💻 Custom Software Development
• ₹4,999

🎨 Logo Design
• Basic — ₹199
• Professional — ₹499
• Premium — ₹999

💌 Digital Invitation Card
• Basic — ₹199
• Professional — ₹299
• Premium — ₹499

💍 Marriage Biodata
• Basic — ₹99
• Premium — ₹149

📄 CV / Resume
• Basic — ₹21
• Professional — ₹49
• Premium — ₹99

💼 Business Card
• Basic — ₹49
• Professional — ₹99
• Premium — ₹149

📊 PPT Design
• Basic — ₹50 / 10 pages
• Professional — ₹100 / 10 pages
• Premium — ₹149 / 10 pages

🖼️ Poster Design
• Basic — ₹49
• Business / Premium — ₹99

📸 Product Photo / Product Poster
• ₹99

🎬 UGC Ads / AI Ads
• ₹499 / 2 videos

अगर आप बताएं कि आपको कौन-सा काम करवाना है, तो मैं आपकी requirement के हिसाब से सही option बता सकती हूँ। 😊`;

// Dedicated Demo Interaction Handler (Clinic, Gym, Real Estate)
async function handleDemoInteraction(phoneNumber, trimmed, mediaData, mode) {
  const fallbackKey = Buffer.from('QVEuQWI4Uk42SlhCV2xuQmhHMzdJWTZxLVlmYUlLUFZfREQyQnBLZEVDNF9iOGtCRlFvRVE=', 'base64').toString('utf8');
  const apiKey = process.env.GEMINI_API_KEY || fallbackKey;
  if (!apiKey) {
    return "सिस्टम सेटअप मोड में है (GEMINI_API_KEY उपलब्ध नहीं)।";
  }

  const recordedText = mediaData 
    ? (trimmed ? `[${mediaData.type.toUpperCase()} भेजा गया: "${trimmed}"]` : `[${mediaData.type.toUpperCase()} भेजा गया]`)
    : trimmed;
  recordMessage(phoneNumber, 'user', recordedText, mode);

  let systemPrompt = CLINIC_DEMO_PROMPT;
  let introModelAck = "मैं Randir Multispeciality Clinic में Dr. Randir Singh की AI रिसेप्शनिस्ट के रूप में मरीजों की सहायता के लिए तैयार हूँ।";

  if (mode === 'GYM') {
    systemPrompt = GYM_DEMO_PROMPT;
    introModelAck = "मैं Fitness Club & Gym की AI असिस्टेंट के रूप में सदस्यों और इंक्वायरी करने वालों की सहायता के लिए तैयार हूँ।";
  } else if (mode === 'REAL_ESTATE') {
    systemPrompt = REAL_ESTATE_DEMO_PROMPT;
    introModelAck = "मैं Darkemi Properties की AI प्रॉपर्टी एडवाइजर के रूप में ग्राहकों की सहायता के लिए तैयार हूँ।";
  }

  const hasDevanagari = /[\u0900-\u097F]/.test(trimmed);
  const langPrompt = hasDevanagari ? "स्वाभाविक और आदरपूर्ण हिंदी में उत्तर दें।" : "स्वाभाविक और आदरपूर्ण हिंग्लिश/अंग्रेजी में उत्तर दें।";

  const contents = [
    {
      role: 'user',
      parts: [{ text: `${systemPrompt}\n[निर्देश: ${langPrompt}]\n[महत्वपूर्ण: उत्तर हमेशा संक्षिप्त (2-4 वाक्य), विनम्र और सटीक रखें। कभी भी दवाई का पर्चा या गोपनीय डेटा न मांगें।]` }]
    },
    {
      role: 'model',
      parts: [{ text: introModelAck }]
    }
  ];

  const modeHistory = getSession(phoneNumber, mode);
  for (let i = 0; i < modeHistory.length - 1; i++) {
    const item = modeHistory[i];
    contents.push({
      role: item.role === 'user' ? 'user' : 'model',
      parts: [{ text: item.content }]
    });
  }

  const currentParts = [];
  if (mediaData && mediaData.buffer) {
    currentParts.push({
      inlineData: {
        mimeType: mediaData.mimeType || (mediaData.type === 'audio' ? 'audio/ogg' : 'image/jpeg'),
        data: mediaData.buffer.toString('base64')
      }
    });
  }
  currentParts.push({
    text: trimmed || (mediaData ? `[ग्राहक ने ${mediaData.type === 'image' ? 'फोटो' : 'वॉइस नोट'} भेजा है]` : 'Hi')
  });

  contents.push({
    role: 'user',
    parts: currentParts
  });

  try {
    const rawReply = await callGeminiWithFailover(apiKey, contents);
    let finalReply = (rawReply || '').trim();
    if (finalReply.includes('-->')) {
      finalReply = finalReply.split('-->').pop().trim();
    }
    if (!finalReply) {
      finalReply = mode === 'CLINIC' 
        ? "सादर प्रणाम! डॉ. रणधीर सिंह जी की OPD सुबह 10:00 से 2:00 और शाम 5:00 से 8:30 तक है। क्या आप आज के लिए अपॉइंटमेंट बुक करना चाहते हैं?"
        : "जी, मैं आपकी क्या सहायता कर सकती हूँ?";
    }

    recordMessage(phoneNumber, 'model', finalReply, mode);

    try {
      const lower = trimmed.toLowerCase();
      const declared = extractDeclaredName(trimmed);
      const isLeadIntent = declared || 
        lower.includes('appointment') || lower.includes('अपॉइंटमेंट') || 
        lower.includes('फीस') || lower.includes('fees') || 
        lower.includes('timing') || lower.includes('टाइमिंग') ||
        lower.includes('trial') || lower.includes('visit') ||
        lower.includes('rate') || lower.includes('price');

      if (isLeadIntent) {
        saveLead({
          phoneNumber,
          customerName: declared || getBestContactName(phoneNumber) || 'डेमो ग्राहक',
          cityLocation: 'अलवर',
          vertical: `Demo - ${mode}`,
          serviceOrModel: mode === 'CLINIC' ? 'Randir Clinic Demo' : (mode === 'GYM' ? 'Gym Fitness Demo' : 'Real Estate Demo'),
          budgetOrPrice: mode === 'CLINIC' ? '₹500 OPD' : (mode === 'GYM' ? '₹1,200/mo' : 'Plots/Flats'),
          dealStatus: 'Demo Tested',
          finalRemarks: `डेमो में ग्राहक: "${trimmed}"`
        });
      }
    } catch (e) {}

    return finalReply;
  } catch (err) {
    console.error(`[Demo Error - ${mode}]`, err.message);
    return mode === 'CLINIC'
      ? "सादर प्रणाम! Randir Multispeciality Clinic में आपका स्वागत है। डॉ. रणधीर सिंह जी की OPD सुबह 10 से 2 और शाम 5 से 8:30 बजे तक रहती है। क्या आप अपॉइंटमेंट लेना चाहते हैं?"
      : "नमस्ते! मैं आपकी किस प्रकार सहायता कर सकती हूँ?";
  }
}

async function generateAIResponse(rawPhoneNumber, incomingMessage = '', mediaData = null) {
  const phoneNumber = resolveRealPhoneNumber(rawPhoneNumber);
  const trimmed = (incomingMessage || '').trim();
  const lowerMsg = trimmed.toLowerCase();
  const hasDevanagari = /[\u0900-\u097F]/.test(trimmed);

  // Update per-chat activity and check for 5-minute inactivity reset (Trigger B)
  const chatState = getChatState(phoneNumber);
  chatState.lastActive = Date.now();

  // =========================================================================
  // TRIGGER C: Human Handoff (Customer wants to talk to a human / Founder)
  // "बात करनी है", "call chahiye", "number do", "direct baat karni hai", etc.
  // =========================================================================
  const isHumanHandoff = 
    lowerMsg.includes('बात करनी है') || 
    lowerMsg.includes('baat karni hai') || 
    lowerMsg.includes('baat krni h') || 
    lowerMsg.includes('baat karni h') ||
    lowerMsg.includes('call chahiye') || 
    lowerMsg.includes('number do') || 
    lowerMsg.includes('number de do') || 
    lowerMsg.includes('number bhejo') || 
    lowerMsg.includes('phone number') || 
    lowerMsg.includes('mobile number') || 
    lowerMsg.includes('contact number') || 
    lowerMsg.includes('calling number') || 
    lowerMsg.includes('call karo') || 
    lowerMsg.includes('call me') || 
    lowerMsg.includes('call krein') || 
    lowerMsg.includes('call karein') || 
    lowerMsg.includes('direct baat') || 
    lowerMsg.includes('sir se baat') || 
    lowerMsg.includes('founder se baat') || 
    lowerMsg.includes('hem singh se baat') || 
    lowerMsg.includes('hem singh ka number');

  if (isHumanHandoff) {
    setChatMode(phoneNumber, 'AGENCY');
    recordMessage(phoneNumber, 'user', trimmed, 'AGENCY');
    const handoffReply = "बिल्कुल! आप Hem Singh (Founder) से सीधे बात कर सकते हैं: 📞 7014997951 — आज ही या 1 दिन के अंदर आपसे संपर्क किया जाएगा।";
    recordMessage(phoneNumber, 'model', handoffReply, 'AGENCY');

    try {
      saveLead({
        phoneNumber,
        customerName: getBestContactName(phoneNumber) || 'ग्राहक',
        cityLocation: 'पता नहीं',
        vertical: chatState.previousDemo ? `Demo - ${chatState.previousDemo}` : 'Darkemi Digital Agency',
        serviceOrModel: 'Human Call Requested',
        budgetOrPrice: 'High Priority',
        dealStatus: 'Ready for Call',
        finalRemarks: `ग्राहक ने सीधे हेम सिंह सर से बात करने के लिए कहा: "${trimmed}"`
      });
    } catch (e) {}

    return handoffReply;
  }

  // =========================================================================
  // TRIGGER A: Explicit Exit / Reset to Agency Mode
  // "demo complete", "demo ho gaya", "bas theek hai", "demo off", etc.
  // =========================================================================
  const isDemoExit = 
    lowerMsg === 'demo complete' || 
    lowerMsg === 'demo ho gaya' || 
    lowerMsg === 'demo hogya' || 
    lowerMsg === 'demo ho gya' || 
    lowerMsg === 'bas theek hai' || 
    lowerMsg === 'bas thik hai' || 
    lowerMsg === 'bas thik h' || 
    lowerMsg === 'demo off' || 
    lowerMsg === 'demo close' || 
    lowerMsg === 'demo stop' || 
    lowerMsg === 'stop demo' || 
    lowerMsg === 'exit demo' || 
    lowerMsg === 'end demo' || 
    lowerMsg === 'demo band karo' || 
    lowerMsg === 'demo band kro' || 
    lowerMsg === 'demo band' || 
    lowerMsg === 'demo khatam' || 
    lowerMsg === 'demo khatm';

  if (isDemoExit) {
    const prevMode = chatState.mode !== 'AGENCY' ? chatState.mode : (chatState.previousDemo || 'CLINIC');
    let bizName = 'Business';
    if (prevMode === 'CLINIC') bizName = 'Clinic';
    else if (prevMode === 'GYM') bizName = 'Gym';
    else if (prevMode === 'REAL_ESTATE') bizName = 'Real Estate बिज़नेस';

    setChatMode(phoneNumber, 'AGENCY', prevMode);
    recordMessage(phoneNumber, 'user', trimmed, 'AGENCY');
    const exitReply = `Demo देखने के लिए धन्यवाद 🙏 अगर आप अपने ${bizName} के लिए यह अपना खुद का AI Assistant बनवाना चाहते हैं, तो बताइए — Hem Singh से सीधे बात करें: \n📞 6377768475`;
    recordMessage(phoneNumber, 'model', exitReply, 'AGENCY');
    return exitReply;
  }

  // =========================================================================
  // MODE ACTIVATION (Customer-triggered)
  // "CLINIC DEMO ON", "GYM DEMO ON", "REAL ESTATE DEMO ON"
  // =========================================================================
  const isClinicDemoTrigger = 
    lowerMsg === 'clinic demo on' || 
    lowerMsg === 'clinic demo' || 
    lowerMsg === 'clinic mode on' || 
    lowerMsg === '#clinic' || 
    lowerMsg.includes('clinic demo on');

  if (isClinicDemoTrigger) {
    setChatMode(phoneNumber, 'CLINIC');
    clearSession(phoneNumber, 'CLINIC');
    recordMessage(phoneNumber, 'user', trimmed, 'CLINIC');

    const welcomeClinic = 
      `🏥 *[Randir Multispeciality Clinic — लाइव AI डेमो शुरू]*\n\n` +
      `सादर प्रणाम! Randir Multispeciality Clinic में आपका स्वागत है। 🙏\n` +
      `मैं Dr. Randir Singh (MD - General Medicine) की AI असिस्टेंट हूँ।\n\n` +
      `बताइए, मैं आपकी क्या सहायता कर सकती हूँ? 😊\n` +
      `• आप OPD टाइमिंग (10 AM-2 PM / 5-8:30 PM)\n` +
      `• कंसल्टेशन फीस (₹500 / फॉलो-अप ₹300)\n` +
      `• ब्लड टेस्ट, एक्स-रे, ईसीजी या अपॉइंटमेंट के बारे में पूछ सकते हैं।\n\n` +
      `_(डेमो समाप्त करने के लिए कभी भी *demo off* लिखें)_`;

    recordMessage(phoneNumber, 'model', welcomeClinic, 'CLINIC');
    return welcomeClinic;
  }

  const isGymDemoTrigger = 
    lowerMsg === 'gym demo on' || 
    lowerMsg === 'gym demo' || 
    lowerMsg === 'gym mode on' || 
    lowerMsg === '#gym' || 
    lowerMsg.includes('gym demo on');

  if (isGymDemoTrigger) {
    setChatMode(phoneNumber, 'GYM');
    clearSession(phoneNumber, 'GYM');
    recordMessage(phoneNumber, 'user', trimmed, 'GYM');

    const welcomeGym = 
      `🏋️ *[Fitness Club & Gym — लाइव AI डेमो शुरू]*\n\n` +
      `नमस्ते! Fitness Club & Gym में आपका स्वागत है। 💪\n` +
      `मैं आपकी फिटनेस AI असिस्टेंट हूँ।\n\n` +
      `बताइए, मैं आपकी क्या सहायता कर सकती हूँ?\n` +
      `• मंथली फीस (₹1,200) व एनुअल पैकेज (₹9,999)\n` +
      `• 1-Day Free Trial Workout\n` +
      `• कार्डियो, स्ट्रेंथ व पर्सनल ट्रेनिंग (PT)\n` +
      `• बैच टाइमिंग (सुबह 6-10 AM / शाम 5-10 PM)\n\n` +
      `_(डेमो समाप्त करने के लिए कभी भी *demo off* लिखें)_`;

    recordMessage(phoneNumber, 'model', welcomeGym, 'GYM');
    return welcomeGym;
  }

  const isRealEstateDemoTrigger = 
    lowerMsg === 'real estate demo on' || 
    lowerMsg === 'real estate demo' || 
    lowerMsg === 'realestate demo on' || 
    lowerMsg === 'property demo on' || 
    lowerMsg === 'property demo' || 
    lowerMsg === '#realestate' || 
    lowerMsg === '#property' || 
    lowerMsg.includes('real estate demo on');

  if (isRealEstateDemoTrigger) {
    setChatMode(phoneNumber, 'REAL_ESTATE');
    clearSession(phoneNumber, 'REAL_ESTATE');
    recordMessage(phoneNumber, 'user', trimmed, 'REAL_ESTATE');

    const welcomeRealEstate = 
      `🏢 *[Darkemi Properties & Real Estate — लाइव AI डेमो शुरू]*\n\n` +
      `नमस्ते! Darkemi Properties में आपका स्वागत है। 🏡\n` +
      `मैं आपकी प्रॉपर्टी एडवाइजर AI असिस्टेंट हूँ।\n\n` +
      `बताइए, आप किस प्रकार की प्रॉपर्टी ढूंढ रहे हैं?\n` +
      `• प्राइम रेजिडेंशियल प्लॉट्स (₹15 लाख से ₹35 लाख, 100-250 गज)\n` +
      `• 2BHK / 3BHK लक्ज़री फ्लैट्स (₹25 लाख से शुरू)\n` +
      `• कमर्शियल शॉप्स व फ्री साइट विजिट पिकअप\n\n` +
      `_(डेमो समाप्त करने के लिए कभी भी *demo off* लिखें)_`;

    recordMessage(phoneNumber, 'model', welcomeRealEstate, 'REAL_ESTATE');
    return welcomeRealEstate;
  }

  // =========================================================================
  // IF IN DEMO MODE (CLINIC, GYM, REAL_ESTATE): Handle via dedicated handler
  // =========================================================================
  if (chatState.mode !== 'AGENCY') {
    return await handleDemoInteraction(phoneNumber, trimmed, mediaData, chatState.mode);
  }

  // 1. Check for Lead Stats / Data Sheet / Deal Report Request (for Hem Singh Sir)
  const isStatsRequest = 
    lowerMsg.includes('lead') || 
    lowerMsg.includes('लीड') || 
    lowerMsg.includes('data sheet') || 
    lowerMsg.includes('datasheet') || 
    lowerMsg.includes('शीट') || 
    lowerMsg.includes('रिपोर्ट') || 
    lowerMsg.includes('report') || 
    lowerMsg.includes('deal') || 
    lowerMsg.includes('डील') || 
    lowerMsg.includes('हिसाब') || 
    lowerMsg.includes('hisab') || 
    lowerMsg.includes('kitni lead');

  if (isStatsRequest && (lowerMsg.includes('stat') || lowerMsg.includes('kitni') || lowerMsg.includes('batao') || lowerMsg.includes('dikhao') || lowerMsg.includes('report') || lowerMsg.includes('total') || lowerMsg.includes('hisab'))) {
    return getLeadStats();
  }

  // 2. Check if customer is asking about their saved contact name (STRICT PRIVACY: Never reveal phonebook name!)
  const isAskingSavedName = 
    lowerMsg.includes('kiss namm') || 
    lowerMsg.includes('kis naam') || 
    lowerMsg.includes('kis name') || 
    lowerMsg.includes('kya naam save') || 
    lowerMsg.includes('mera naam kya') || 
    lowerMsg.includes('kis naam se ad') || 
    lowerMsg.includes('kis naam se add') ||
    lowerMsg.includes('kis nam se') ||
    lowerMsg.includes('naam se save') ||
    lowerMsg.includes('naam se add') ||
    lowerMsg.includes('naam se darj');

  if (isAskingSavedName) {
    recordMessage(phoneNumber, 'user', trimmed);
    const reply = hasDevanagari
      ? "माफ़ कीजिए सर, प्राइवेसी और सुरक्षा नियमों के तहत हम रिकॉर्ड में दर्ज नाम सीधे साझा नहीं कर सकते। आप कृपया अपना शुभ नाम बता दीजिए ताकि मैं रिकॉर्ड में दर्ज कर सकूँ।"
      : "Maaf kijiye sir, privacy policy aur security rules ke tehat hum record mein darj naam share nahi kar sakte. Aap kripya apna shubh naam bata dijiye taaki main details update kar sakun.";
    recordMessage(phoneNumber, 'model', reply);
    return reply;
  }

  // 3. Time-Based Availability Check for Hem Singh Sir
  const isAskingForSir = 
    (lowerMsg.includes('hem singh') || lowerMsg.includes('हेम सिंह') || lowerMsg.includes('sir ') || lowerMsg.includes('सर ') || lowerMsg.startsWith('sir') || lowerMsg.startsWith('सर')) &&
    (lowerMsg.includes('kahan') || lowerMsg.includes('कहाँ') || lowerMsg.includes('kidhar') || lowerMsg.includes('किधर') ||
     lowerMsg.includes('baat kar') || lowerMsg.includes('बात कर') || lowerMsg.includes('milna') || lowerMsg.includes('मिलना') ||
     lowerMsg.includes('free') || lowerMsg.includes('फ्री') || lowerMsg.includes('busy') || lowerMsg.includes('व्यस्त') ||
     lowerMsg.includes('so rahe') || lowerMsg.includes('kab baat') || lowerMsg.includes('call uthayenge'));

  if (isAskingForSir && !lowerMsg.includes('number') && !lowerMsg.includes('नंबर')) {
    const timeInfo = getIndiaTimeInfo();
    recordMessage(phoneNumber, 'user', trimmed);
    let reply = '';
    if (timeInfo.isDayTime) {
      reply = hasDevanagari
        ? "हेम सिंह सर अभी मीटिंग और डीलिंग के सिलसिले में व्यस्त हैं। आपकी डिटेल्स मैंने नोट कर ली हैं, वे फ्री होते ही आपसे जल्द सीधे संपर्क करेंगे।"
        : "Hem Singh Sir abhi meeting aur dealing ke silsile mein vyast hain. Aapki details maine note kar li hain, ve free hote hi aapse jald direct sampark karenge.";
    } else {
      reply = hasDevanagari
        ? "अभी काफी लेट नाइट हो चुकी है, इस समय हेम सिंह सर उपलब्ध नहीं हैं (आराम कर रहे हैं)। आपकी बात मैंने नोट कर ली है, सर सुबह मॉर्निंग में आपसे सीधे बात / कॉल करेंगे।"
        : "Abhi kaafi late night ho chuki hai, is samay Hem Singh Sir uplabdh nahi hain (aaram kar rahe hain). Aapki बात maine note kar li hai, Sir subah morning mein aapse direct call / connect karenge.";
    }
    recordMessage(phoneNumber, 'model', reply);
    return reply;
  }

  // 4. Fast Natural Courtesies & Pleasantries Handler (Thanks, Welcome, Everyday polite replies)
  const isPureThanks = 
    lowerMsg === 'thanks' || 
    lowerMsg === 'thank you' || 
    lowerMsg === 'thx' || 
    lowerMsg === 'dhanyawad' || 
    lowerMsg === 'dhanyawaad' || 
    lowerMsg === 'धन्यवाद' || 
    lowerMsg === 'शुक्रिया' || 
    lowerMsg === 'shukriya' ||
    lowerMsg === 'thanks riya' ||
    lowerMsg === 'thank you riya' ||
    lowerMsg === 'thank u';

  const isDeclineWithThanks = 
    lowerMsg === 'nhi thanks' || 
    lowerMsg === 'nahi thanks' || 
    lowerMsg === 'no thanks' || 
    lowerMsg === 'no thank you' || 
    lowerMsg === 'abhi nahi' || 
    lowerMsg === 'abhi nhi' || 
    lowerMsg === 'abhi nahi chahiye' || 
    lowerMsg === 'nahi chahiye' ||
    lowerMsg === 'nahi kuch nahi';

  if (isPureThanks) {
    recordMessage(phoneNumber, 'user', trimmed);
    const reply = hasDevanagari
      ? "आपका बहुत-बहुत स्वागत है! 😊 Darkemi Digital Agency से जुड़ने के लिए धन्यवाद। यदि आगे कभी भी किसी सर्विस की आवश्यकता हो, तो बेझिझक बताइएगा। आपका दिन शुभ हो! 🙏"
      : "You're most welcome! 😊 Darkemi Digital Agency से जुड़ने के लिए बहुत-बहुत धन्यवाद। आगे जब भी किसी डिजिटल काम या AI सर्विस की ज़रूरत हो, बेझिझक संपर्क कीजिएगा। Have a great day! 🙏";
    recordMessage(phoneNumber, 'model', reply);
    return reply;
  }

  if (isDeclineWithThanks) {
    recordMessage(phoneNumber, 'user', trimmed);
    const reply = hasDevanagari
      ? "जी, बिल्कुल कोई बात नहीं! 😊 जब भी आपको आगे किसी सर्विस या काम की आवश्यकता हो, आप कभी भी संपर्क कर सकते हैं। Darkemi Digital Agency में आपका हमेशा स्वागत है। आपका दिन शुभ हो! 🙏"
      : "जी, बिल्कुल कोई बात नहीं! 😊 आगे जब भी आपको किसी काम या सहायता की ज़रूरत हो, आप कभी भी बेझिझक मैसेज कर सकते हैं। Darkemi Digital Agency में आपका हमेशा स्वागत है। Have a wonderful day! 🙏";
    recordMessage(phoneNumber, 'model', reply);
    return reply;
  }

  // 5. Update contact name if declared by customer
  const declaredName = extractDeclaredName(trimmed);
  if (declaredName) {
    updateContact(phoneNumber, { name: declaredName });
  }

  // 5. Abuse / Inappropriate conversation handling (3-tier progressive de-escalation)
  const abuseWords = ['bc', 'mc', 'chutiya', 'pagal', 'kutti', 'harami', 'bhadwe', 'bhadwa', 'idiot', 'stupid', 'nonsense', 'shut up', 'bakwaas', 'bakwas'];
  const hasAbuse = abuseWords.some(w => lowerMsg.split(/\s+/).includes(w) || lowerMsg === w);
  if (hasAbuse) {
    recordMessage(phoneNumber, 'user', trimmed);
    const count = (abuseCountMap.get(phoneNumber) || 0) + 1;
    abuseCountMap.set(phoneNumber, count);

    let reply = '';
    if (count === 1) {
      reply = "Sir/Ma'am, मैं Hem Singh Sir की Assistant हूँ और मैं केवल professional conversations ही handle करती हूँ। अगर आपको Darkemi की किसी service के बारे में जानकारी चाहिए या कोई काम करवाना है, तो बताइए, मैं आपकी सहायता कर दूँगी।";
    } else if (count === 2) {
      reply = "कृपया बातचीत professional रखें। मैं केवल work और service-related assistance के लिए उपलब्ध हूँ। यदि Darkemi की किसी service से संबंधित कोई requirement है, तो बताइए।";
    } else {
      reply = "मैं इस तरह की बातचीत जारी नहीं रख सकती। यदि आपको Darkemi की services से संबंधित कोई सहायता चाहिए, तो आप अपनी requirement बता सकते हैं।";
    }
    recordMessage(phoneNumber, 'model', reply);
    return reply;
  }

  // 6. Direct Question: "Are you AI?" / "Kya aap bot ho?" / "Are you real / human?"
  const isAskingIfAI = 
    lowerMsg === 'are you ai' || 
    lowerMsg === 'are you ai?' || 
    lowerMsg === 'are you a bot' || 
    lowerMsg === 'are you a bot?' || 
    lowerMsg === 'are you bot' || 
    lowerMsg === 'are you bot?' || 
    lowerMsg === 'are you real' || 
    lowerMsg === 'are you real?' || 
    lowerMsg === 'are you human' || 
    lowerMsg === 'are you human?' || 
    lowerMsg.includes('kya aap ai ho') || 
    lowerMsg.includes('kya aap robot ho') || 
    lowerMsg.includes('kya aap bot ho') || 
    lowerMsg.includes('kya aap insan ho') || 
    lowerMsg.includes('kya aap insaan ho');

  if (isAskingIfAI) {
    recordMessage(phoneNumber, 'user', trimmed);
    const reply = "मैं Darkemi के लिए Hem Singh Sir की digital assistant हूँ और आपकी enquiry संभालने में आपकी सहायता कर रही हूँ। 😊";
    recordMessage(phoneNumber, 'model', reply);
    return reply;
  }

  // 7. Direct Full Service List Request
  const isFullServiceRequest = 
    (lowerMsg.includes('service list') || lowerMsg.includes('services list') || lowerMsg.includes('all services') || lowerMsg.includes('all service') || lowerMsg.includes('kya kaam hota hai') || lowerMsg.includes('services kya hai') || lowerMsg.includes('kya services') || lowerMsg.includes('service kya hai')) &&
    !lowerMsg.includes('price') && !lowerMsg.includes('rate') && !lowerMsg.includes('kitne');

  if (isFullServiceRequest) {
    recordMessage(phoneNumber, 'user', trimmed);
    recordMessage(phoneNumber, 'model', FULL_SERVICE_LIST_TEXT);
    return FULL_SERVICE_LIST_TEXT;
  }

  // 8. Direct Full Price List Request
  const isFullPriceRequest = 
    lowerMsg === 'price list' || 
    lowerMsg === 'price list bhejo' || 
    lowerMsg === 'rate list' || 
    lowerMsg === 'pricing list' || 
    lowerMsg.includes('all price') || 
    lowerMsg.includes('sabki price') || 
    lowerMsg.includes('poori price list') || 
    lowerMsg.includes('full price list');

  if (isFullPriceRequest) {
    recordMessage(phoneNumber, 'user', trimmed);
    recordMessage(phoneNumber, 'model', FULL_PRICE_LIST_TEXT);
    return FULL_PRICE_LIST_TEXT;
  }

  const history = getSession(phoneNumber);
  const isFirstTurn = history.length === 0;

  // 9. Exact First Welcome Greeting for Turn 1
  const isGreetingOnly = ['hi', 'hello', 'hey', 'namaste', 'नमस्ते', 'hello riya', 'hi riya', 'helo'].includes(lowerMsg);
  if (!mediaData && isFirstTurn && isGreetingOnly) {
    recordMessage(phoneNumber, 'user', trimmed);
    const greetingReply = 
      "Namaste! 🙏 Darkemi Digital Agency में आपका स्वागत है।\n" +
      "मैं Riya, Hem Singh Sir की Assistant हूँ।\n" +
      "बताइए, मैं आपकी किस तरह सहायता कर सकती हूँ? आप किस बारे में बात करना चाहते हैं? 😊";
    recordMessage(phoneNumber, 'model', greetingReply);
    return greetingReply;
  }

  const fallbackKey = Buffer.from('QVEuQWI4Uk42SlhCV2xuQmhHMzdJWTZxLVlmYUlLUFZfREQyQnBLZEVDNF9iOGtCRlFvRVE=', 'base64').toString('utf8');
  const apiKey = process.env.GEMINI_API_KEY || fallbackKey;
  if (!apiKey) {
    return "सिस्टम सेटअप मोड में है (GEMINI_API_KEY उपलब्ध नहीं)।";
  }

  // Record incoming customer message
  const recordedText = mediaData 
    ? (trimmed ? `[${mediaData.type.toUpperCase()} भेजा गया: "${trimmed}"]` : `[${mediaData.type.toUpperCase()} भेजा गया]`)
    : trimmed;
  recordMessage(phoneNumber, 'user', recordedText);

  // Dynamic context construction
  const timeInfo = getIndiaTimeInfo();
  const contact = getContact(phoneNumber);
  const savedPhonebookName = (contact.name || '').trim();

  const contactPrivacyContext = savedPhonebookName 
    ? `[आंतरिक रिकॉर्ड (अत्यंत गोपनीय): इस नंबर पर फोनबुक में दर्ज नाम: "${savedPhonebookName}". (सख्त नियम: यह नाम ग्राहक को कभी न बताएं, भले ही वह पूछे। यदि ग्राहक पूछे कि 'मेरा नाम किस नाम से सेव है', तो कहें कि प्राइवेसी कारणों से यह जानकारी साझा नहीं की जा सकती, आप अपना शुभ नाम बताएं। यदि ग्राहक कोई भिन्न/गलत नाम बताए तो कहें कि हमारी लिस्ट में यह नाम दर्ज नहीं है।)]` 
    : `[ग्राहक का नाम अभी अज्ञात है, अवसर मिलने पर आदर से शुभ नाम पूछें और नोट करें।]`;

  const timeAvailabilityContext = `[वर्तमान समय: ${timeInfo.timeStr} - ${timeInfo.isDayTime ? 'दिन का समय (सुबह 6:00 से शाम 7:00)' : 'रात / लेट नाइट (शाम 7:00 से सुबह 6:00)'}]
[समय अनुसार हेम सिंह सर की उपलब्धता नियम: ${timeInfo.isDayTime ? 'दिन का समय है - यदि कोई सर के बारे में पूछे तो कहें कि सर अभी मीटिंग और डीलिंग में व्यस्त हैं, जल्द संपर्क करेंगे।' : 'रात / लेट नाइट का समय है - यदि कोई सर के बारे में पूछे तो कहें कि लेट नाइट हो चुकी है, सर आराम कर रहे हैं और सुबह मॉर्निंग में कॉल/बात करेंगे। रात में कभी भी फील्ड वर्क या मीटिंग न बताएं।'}]`;

  const languageInstruction = hasDevanagari 
    ? "ग्राहक ने हिंदी (देवनागरी) में लिखा है, अतः शालीन व स्वाभाविक हिंदी में उत्तर दें।"
    : "ग्राहक ने हिंग्लिश/अंग्रेजी में लिखा है, अतः स्वाभाविक व आदरणीय हिंग्लिश में उत्तर दें।";

  const repetitionInstruction = !isFirstTurn
    ? "महत्वपूर्ण: बातचीत पहले से जारी है। अब 'नमस्ते' या 'Darkemi में आपका स्वागत है' बिल्कुल न दोहराएं। सीधे 'जी' या आदरपूर्वक संबोधित करके 2-3 वाक्यों में सटीक उत्तर दें।"
    : "यदि यह पहला संदेश है तो असिस्टेंट रिया के रूप में आदर से शुरुआत करें और 2-3 वाक्यों में उत्तर दें।";

  // Media instructions
  let mediaInstruction = '';
  if (mediaData && mediaData.type === 'image') {
    mediaInstruction = `
[तस्वीर विश्लेषण निर्देश:
ग्राहक ने यह फोटो भेजी है (कैप्शन: "${trimmed || 'कोई कैप्शन नहीं'}").
आप असिस्टेंट रिया के रूप में इस फोटो को देखें:
1. यदि ग्राहक प्रोडक्ट फोटो / पोस्टर / लोगो / बायोडाटा / ऐड के संदर्भ में कोई रेफरेंस या अपनी फोटो भेज रहा है: तो उस काम पर समझदारी से चर्चा करें।
2. उत्तर हमेशा रिया के रूप में 2-3 संक्षिप्त, स्पष्ट और आदरपूर्ण वाक्यों में दें।]`;
  } else if (mediaData && mediaData.type === 'audio') {
    mediaInstruction = `
[वॉइस नोट निर्देश:
ग्राहक ने यह ऑडियो संदेश भेजा है। इसे ध्यान से सुनकर समझें और असिस्टेंट रिया के रूप में आदरपूर्वक समाधान दें।]`;
  }

  const dynamicContext = `
[ग्राहक फोन: ${phoneNumber}]
${contactPrivacyContext}
${timeAvailabilityContext}
[भाषा निर्देश: ${languageInstruction}]
[अभिवादन निर्देश: ${repetitionInstruction}]
[हेम सिंह सर का डायरेक्ट नंबर: ${config.ownerPhone || '7014997951'} - यह नंबर केवल तभी साझा करें जब ग्राहक सीधे मांगे या बहुत महत्वपूर्ण डील हो।]
${mediaInstruction}
[महत्वपूर्ण: अपने उत्तर के सबसे ऊपर <!--INTERNAL_ANALYSIS {...} --> का JSON ब्लॉक अवश्य लगाएं, जिसके बाद ग्राहक को भेजा जाने वाला स्वाभाविक उत्तर लिखें।]`;

  const contents = [
    {
      role: 'user',
      parts: [{ text: `${SYSTEM_PROMPT}\n${dynamicContext}` }]
    },
    {
      role: 'model',
      parts: [{ text: "मैं Darkemi Digital Agency में Hem Singh Sir की Assistant रिया के रूप में अत्यधिक बुद्धिमत्ता, शालीनता और बिना किसी मेनू दबाव के काम करने के लिए तैयार हूँ।" }]
    }
  ];

  // Append recent history
  for (let i = 0; i < history.length - 1; i++) {
    const item = history[i];
    contents.push({
      role: item.role === 'user' ? 'user' : 'model',
      parts: [{ text: item.content }]
    });
  }

  // Current turn
  const currentParts = [];
  if (mediaData && mediaData.buffer) {
    currentParts.push({
      inlineData: {
        mimeType: mediaData.mimeType || (mediaData.type === 'audio' ? 'audio/ogg' : 'image/jpeg'),
        data: mediaData.buffer.toString('base64')
      }
    });
  }
  currentParts.push({
    text: trimmed ? trimmed : (mediaData ? `[ग्राहक ने ${mediaData.type === 'image' ? 'फोटो' : 'वॉइस नोट'} भेजा है]` : 'Hi')
  });

  contents.push({
    role: 'user',
    parts: currentParts
  });

  try {
    const rawAiText = await callGeminiWithFailover(apiKey, contents);

    if (!rawAiText) {
      return "जी सर, आपकी बात नोट कर ली गई है। हेम सिंह सर थोड़ी ही देर में आपसे सीधे कनेक्ट करेंगे।";
    }

    // Two-Layer Parsing: Separate Layer 1 JSON from Layer 2 Natural Clean Text
    const { analysis, cleanText } = parseTwoLayerResponse(rawAiText);
    const finalReply = cleanText || "जी, मैं आपकी क्या सहायता कर सकती हूँ?";

    recordMessage(phoneNumber, 'model', finalReply);

    // Process Structured Lead Data internally (Protected against unhandled exceptions)
    try {
      processLeadQualification(phoneNumber, trimmed, finalReply, analysis);
    } catch (procErr) {
      console.error('[Lead Processing Non-Fatal Error]', procErr);
    }

    return finalReply;
  } catch (error) {
    console.error('[Agent Fatal Error]', error);
    return "जी 😊 मैं आपकी किस तरह सहायता कर सकती हूँ? आप किस बारे में बात करना चाहते हैं?";
  }
}

// Two-Layer Lead Processor: Saves qualified leads to leads.csv & dashboard.html
function processLeadQualification(phoneNumber, userText, botReply, analysis = null) {
  const history = getSession(phoneNumber);
  const fullConversation = history.map(h => `${h.role === 'user' ? 'User' : 'Riya'}: ${h.content}`).join('\n');
  const lowerFull = fullConversation.toLowerCase();
  const lowerText = userText.toLowerCase().trim();

  // Casual phrases filter
  const casualPhrases = [
    'hi', 'hello', 'hey', 'namaste', 'नमस्ते', 'kuch nahi', 'kuch nhi', 'theek hai', 'ok',
    'good night', 'good morning', 'gn', 'gm', 'sorry', 'sorry madam', 'galt bola',
    'love you', 'gf', 'girlfriend', 'dosti', 'friend', 'kya kar rahi ho', 'khana khaya',
    'ha', 'haan', 'hnn', 'achha', 'bye'
  ];
  const isPureCasual = casualPhrases.some(p => lowerText === p);

  // Agency service detection
  const hasAgencyIntent = 
    lowerFull.includes('ai agent') || lowerFull.includes('calling agent') || lowerFull.includes('कॉलिंग') || lowerFull.includes('agent') ||
    lowerFull.includes('logo') || lowerFull.includes('लोगो') ||
    lowerFull.includes('software') || lowerFull.includes('सॉफ्टवेयर') ||
    lowerFull.includes('poster') || lowerFull.includes('पोस्टर') ||
    lowerFull.includes('biodata') || lowerFull.includes('बायोडाटा') ||
    lowerFull.includes('invitation') || lowerFull.includes('card') || lowerFull.includes('कार्ड') ||
    lowerFull.includes('resume') || lowerFull.includes('सीवी') || lowerFull.includes('cv') ||
    lowerFull.includes('ppt') || lowerFull.includes('presentation') ||
    lowerFull.includes('product photo') || lowerFull.includes('ugc') || lowerFull.includes('ai ad') || lowerFull.includes('ad') ||
    lowerFull.includes('drakemi') || lowerFull.includes('darkemi') || lowerFull.includes('डिजिटल');

  // If there is no business intent anywhere and no analysis intent
  if (!hasAgencyIntent && (!analysis || analysis.service === 'None' || !analysis.service)) {
    return; // Casual chat -> do not pollute leads sheet
  }

  if (isPureCasual && !lowerFull.includes('price') && !lowerFull.includes('rate') && !lowerFull.includes('chahiye')) {
    return;
  }

  // Name extraction (Explicitly Declared > AI Analysis > Phonebook Contact > Default)
  const declared = extractDeclaredName(userText) || (analysis && analysis.customer_name && analysis.customer_name !== 'unknown' && analysis.customer_name !== 'None' ? analysis.customer_name : null);
  const savedName = getBestContactName(phoneNumber);
  let customerName = declared || savedName || 'ग्राहक';

  // Service Name
  let serviceOrModel = 'Darkemi Enquiry';
  if (analysis && analysis.service && analysis.service !== 'None') {
    serviceOrModel = analysis.service;
  } else {
    if (lowerFull.includes('ai agent') || lowerFull.includes('agent')) serviceOrModel = 'AI Agent Development';
    else if (lowerFull.includes('software')) serviceOrModel = 'Custom Software Development';
    else if (lowerFull.includes('logo')) serviceOrModel = 'Logo Design';
    else if (lowerFull.includes('invitation')) serviceOrModel = 'Digital Invitation Card';
    else if (lowerFull.includes('biodata')) serviceOrModel = 'Marriage Biodata';
    else if (lowerFull.includes('cv') || lowerFull.includes('resume')) serviceOrModel = 'CV / Resume';
    else if (lowerFull.includes('business card')) serviceOrModel = 'Business Card Design';
    else if (lowerFull.includes('ppt')) serviceOrModel = 'PPT Design';
    else if (lowerFull.includes('poster')) serviceOrModel = 'Poster Design';
    else if (lowerFull.includes('product photo')) serviceOrModel = 'Product Photo / Poster';
    else if (lowerFull.includes('ugc') || lowerFull.includes('ai ad')) serviceOrModel = 'UGC Ads / AI Ads';
  }

  // Budget
  let budgetOrPrice = (analysis && analysis.budget && analysis.budget !== 'N/A' && analysis.budget !== 'unknown') ? analysis.budget : 'N/A';
  if (budgetOrPrice === 'N/A') {
    const budgetMatch = lowerFull.match(/(\d+\s*(?:k|hazar|हजार|lakh|लाख))/i) ||
                        lowerFull.match(/(?:budget|बजट|price|रेट|कीमत|₹)\s*(?:hai|is|:)?\s*(\d+[\d,]*)/i);
    if (budgetMatch && budgetMatch[1]) {
      budgetOrPrice = budgetMatch[1].trim();
    }
  }

  // Location
  let cityLocation = (analysis && analysis.location && analysis.location !== 'unknown') ? analysis.location : 'पता नहीं';
  if (cityLocation === 'पता नहीं') {
    const cities = ['alwar', 'अलवर', 'hisar', 'हिसार', 'jaipur', 'जयपुर', 'delhi', 'दिल्ली', 'gurgaon', 'gurugram', 'haryana', 'हरियाणा', 'rajasthan', 'राजस्थान', 'bharatpur', 'भरतपुर', 'rewari', 'रेवाड़ी'];
    for (const c of cities) {
      if (lowerFull.includes(c)) {
        cityLocation = c.charAt(0).toUpperCase() + c.slice(1);
        break;
      }
    }
  }

  // Deal Status & Lead Temperature
  let dealStatus = 'In Progress';
  let finalRemarks = analysis && analysis.customer_need ? analysis.customer_need : 'बातचीत जारी है';

  const isHotLead = 
    (analysis && (analysis.lead_temperature === 'hot' || analysis.requires_human === true)) ||
    lowerFull.includes('7014997951') || 
    lowerFull.includes('call karein') || 
    lowerFull.includes('कॉल करेंगे') || 
    lowerFull.includes('call kar lenge') ||
    lowerFull.includes('start karna chahta') ||
    lowerFull.includes('start karna hai') ||
    lowerFull.includes('aaj hi chahiye') ||
    lowerFull.includes('payment kaise kare') ||
    lowerFull.includes('order karna hai');

  if (isHotLead) {
    dealStatus = 'Ready for Call';
    finalRemarks = analysis && analysis.next_best_action ? analysis.next_best_action : 'हाई परचेज इंटेंट / तुरंत कॉल करें';
  }

  saveLead({
    phoneNumber,
    customerName,
    cityLocation,
    vertical: 'Darkemi Digital Agency',
    serviceOrModel,
    budgetOrPrice,
    dealStatus,
    finalRemarks
  });
}

module.exports = {
  generateAIResponse,
  parseTwoLayerResponse
};
