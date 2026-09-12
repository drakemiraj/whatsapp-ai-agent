# 🚀 WhatsApp Multi-Business AI Agent (हेम सिंह / drmick)

यह AI एजेंट आपके 3 प्रमुख व्यवसायों के WhatsApp मैसेज को स्वचालित और पेशेवर रूप से संभालता है:
1. **वाहन क्रय-विक्रय (Vehicle Buy & Sell)**
2. **drmick एजेंसी (12 डिजिटल सेवाएं)**
3. **फिजिकल वेरिफिकेशन (Physical Verification)**

---

## 📁 प्रोजेक्ट स्ट्रक्चर (Project Structure)

- `index.js` - मुख्य फाइल जो WhatsApp Web को QR कोड से कनेक्ट करती है।
- `agent.js` - Gemini AI इंजन जो 15-20 संदेशों की मेमोरी बनाए रखता है और रिप्लाई तैयार करता है।
- `prompts.js` - सिस्टम रूल्स और बिजनेस लॉजिक।
- `config.json` - आपकी सेटिंग्स (नाम, सर्विसेज, वेरिफिकेशन मैसेज आदि)।
- `leadsManager.js` - आने वाले ग्राहकों के नाम, फोन नंबर और विवरण को `leads.csv` (एक्सेल) में ऑटो-सेव करता है।
- `leads.csv` - सभी लीड्स की एक्सेल फाइल।

---

## 🛠️ सेटअप और चलाने का तरीका (Step-by-Step Run Guide)

### चरण 1: Node.js इंस्टॉल करें (सिर्फ पहली बार)
अपने कंप्यूटर के PowerShell में यह कमांड चलाएं (या [nodejs.org](https://nodejs.org) से डाउनलोड करें):
```bash
winget install OpenJS.NodeJS.LTS
```
*(इंस्टॉल होने के बाद एक बार टर्मिनल को दोबारा खोलें)*

### चरण 2: प्रोजेक्ट फोल्डर में जाएं
```bash
cd C:\Users\lenovo\.gemini\antigravity\scratch\whatsapp-ai-agent
```

### चरण 3: डिपेंडेंसी इंस्टॉल करें
```bash
npm install
```

### चरण 4: अपनी Gemini API Key डालें
1. [Google AI Studio](https://aistudio.google.com/) पर जाएं और **Get API Key** पर क्लिक करके फ्री API Key कॉपी करें।
2. `.env.example` का नाम बदलकर `.env` कर लें, या नई `.env` फाइल बनाकर उसमें अपनी की (Key) पेस्ट करें:
```env
GEMINI_API_KEY=AIzaSy...आपकी_की
```

### चरण 5: बॉट शुरू करें
```bash
npm start
```
टर्मिनल में एक **QR Code** दिखाई देगा:
1. अपने फोन में WhatsApp खोलें।
2. **Linked Devices (लिंक्ड डिवाइसेज)** पर जाएं।
3. **Link a Device** दबाकर टर्मिनल में दिख रहे QR Code को स्कैन करें।

✅ **बस, आपका AI एजेंट 24/7 लाइव हो गया!**

---

## 📊 लीड्स (Leads) कैसे देखें?
जैसे ही कोई ग्राहक drmick या वाहन के संबंध में बात करेगा, उसकी एंट्री अपने आप **`leads.csv`** में जुड़ जाएगी। आप सीधे इस फाइल पर डबल-क्लिक करके इसे Microsoft Excel में देख सकते हैं।
