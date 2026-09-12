const fs = require('fs');
const path = require('path');

const LEADS_JSON_PATH = path.join(__dirname, 'leads.json');
const LEADS_CSV_PATH = path.join(__dirname, 'leads.csv');
const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');

// Initialize files if they don't exist
function initStorage() {
  if (!fs.existsSync(LEADS_JSON_PATH)) {
    fs.writeFileSync(LEADS_JSON_PATH, JSON.stringify([], null, 2), 'utf-8');
  }
  if (!fs.existsSync(LEADS_CSV_PATH)) {
    const csvHeader = 'Timestamp,PhoneNumber,CustomerName,CityLocation,Vertical,ServiceOrModel,BudgetOrPrice,DealStatus,FinalRemarks\n';
    fs.writeFileSync(LEADS_CSV_PATH, csvHeader, 'utf-8');
  }
  renderDashboard();
}

// Upsert or Save a lead
function saveLead({ 
  phoneNumber, 
  customerName = 'ग्राहक', 
  cityLocation = 'पता नहीं',
  vertical = 'सामान्य पूछताछ', 
  serviceOrModel = 'General Inquiry', 
  budgetOrPrice = 'N/A', 
  dealStatus = 'In Progress', 
  finalRemarks = '' 
}) {
  initStorage();

  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  // Read existing leads
  let data = [];
  try {
    data = JSON.parse(fs.readFileSync(LEADS_JSON_PATH, 'utf-8'));
  } catch (err) {
    data = [];
  }

  // Find if a lead already exists for this phone number
  const existingIndex = data.findIndex(item => item.phoneNumber === phoneNumber);

  const leadEntry = {
    timestamp,
    phoneNumber,
    customerName: customerName !== 'ग्राहक' ? customerName : (existingIndex >= 0 && data[existingIndex].customerName !== 'ग्राहक' ? data[existingIndex].customerName : 'ग्राहक'),
    cityLocation: cityLocation !== 'पता नहीं' ? cityLocation : (existingIndex >= 0 && data[existingIndex].cityLocation !== 'पता नहीं' ? data[existingIndex].cityLocation : 'पता नहीं'),
    vertical: vertical !== 'सामान्य पूछताछ' ? vertical : (existingIndex >= 0 ? data[existingIndex].vertical : vertical),
    serviceOrModel: serviceOrModel !== 'General Inquiry' ? serviceOrModel : (existingIndex >= 0 ? data[existingIndex].serviceOrModel : serviceOrModel),
    budgetOrPrice: budgetOrPrice !== 'N/A' ? budgetOrPrice : (existingIndex >= 0 ? data[existingIndex].budgetOrPrice : budgetOrPrice),
    dealStatus: dealStatus || (existingIndex >= 0 ? data[existingIndex].dealStatus : 'In Progress'),
    finalRemarks: finalRemarks || (existingIndex >= 0 ? data[existingIndex].finalRemarks : '')
  };

  if (existingIndex >= 0) {
    data[existingIndex] = leadEntry;
  } else {
    data.push(leadEntry);
  }

  // Save to JSON
  try {
    fs.writeFileSync(LEADS_JSON_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving to leads.json:', err.message);
  }

  // Re-write CSV completely for clean structure
  try {
    const sanitize = (text) => `"${String(text || '').replace(/"/g, '""')}"`;
    const csvHeader = 'Timestamp,PhoneNumber,CustomerName,CityLocation,Vertical,ServiceOrModel,BudgetOrPrice,DealStatus,FinalRemarks\n';
    const csvRows = data.map(l => 
      `${sanitize(l.timestamp)},${sanitize(l.phoneNumber)},${sanitize(l.customerName)},${sanitize(l.cityLocation)},${sanitize(l.vertical)},${sanitize(l.serviceOrModel)},${sanitize(l.budgetOrPrice)},${sanitize(l.dealStatus)},${sanitize(l.finalRemarks)}`
    ).join('\n');
    fs.writeFileSync(LEADS_CSV_PATH, csvHeader + csvRows + '\n', 'utf-8');
    console.log(`[Lead Updated] ${leadEntry.customerName} (${phoneNumber}) | Status: ${leadEntry.dealStatus} -> leads.csv`);
  } catch (err) {
    console.error('Error writing to leads.csv:', err.message);
  }

  // Update HTML Dashboard
  renderDashboard();

  return leadEntry;
}

// Generate an elegant, live auto-refreshing HTML Dashboard
function renderDashboard() {
  try {
    let data = [];
    if (fs.existsSync(LEADS_JSON_PATH)) {
      data = JSON.parse(fs.readFileSync(LEADS_JSON_PATH, 'utf-8'));
    }

    const total = data.length;
    let readyForCall = 0;
    let inProgress = 0;
    let closed = 0;
    let rejected = 0;

    data.forEach(l => {
      const s = (l.dealStatus || '').toLowerCase();
      if (s.includes('call') || s.includes('ready')) readyForCall++;
      else if (s.includes('closed') || s.includes('booked') || s.includes('सफल')) closed++;
      else if (s.includes('rejected') || s.includes('cancel') || s.includes('रद्द')) rejected++;
      else inProgress++;
    });

    const rowsHtml = data.slice().reverse().map(l => {
      let badgeClass = 'badge-progress';
      const s = (l.dealStatus || '').toLowerCase();
      if (s.includes('call') || s.includes('ready')) badgeClass = 'badge-call';
      else if (s.includes('closed') || s.includes('booked')) badgeClass = 'badge-closed';
      else if (s.includes('rejected') || s.includes('cancel')) badgeClass = 'badge-rejected';

      return `
        <tr>
          <td><small>${l.timestamp}</small></td>
          <td><b>${l.phoneNumber}</b></td>
          <td>${l.customerName && l.customerName !== 'ग्राहक' ? l.customerName : 'N/A'}</td>
          <td><span class="city-tag">${l.cityLocation && l.cityLocation !== 'पता नहीं' ? l.cityLocation : 'N/A'}</span></td>
          <td>${l.vertical || 'General'}</td>
          <td>${l.serviceOrModel || l.serviceOrDetails || 'Inquiry'}</td>
          <td>${l.budgetOrPrice || '-'}</td>
          <td><span class="badge ${badgeClass}">${l.dealStatus || 'In Progress'}</span></td>
          <td><small>${l.finalRemarks || '-'}</small></td>
        </tr>
      `;
    }).join('');

    const html = `
<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <title>Darkemi Digital Agency - Live Leads & Deals Dashboard</title>
  <meta http-equiv="refresh" content="15">
  <style>
    body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 25px; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 15px; margin-bottom: 25px; }
    h1 { margin: 0; font-size: 24px; color: #38bdf8; display: flex; align-items: center; gap: 10px; }
    .sub { color: #94a3b8; font-size: 14px; margin-top: 5px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 25px; }
    .stat-card { background: #1e293b; padding: 20px; border-radius: 14px; border: 1px solid #334155; }
    .stat-num { font-size: 32px; font-weight: bold; margin-top: 5px; }
    .stat-label { font-size: 13px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
    .card-total { border-left: 4px solid #38bdf8; }
    .card-call { border-left: 4px solid #f59e0b; }
    .card-progress { border-left: 4px solid #60a5fa; }
    .card-closed { border-left: 4px solid #10b981; }
    .card-rejected { border-left: 4px solid #ef4444; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 14px; overflow: hidden; border: 1px solid #334155; }
    th, td { padding: 14px 16px; text-align: left; border-bottom: 1px solid #334155; font-size: 14px; }
    th { background: #0f172a; color: #cbd5e1; font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: 0.5px; }
    tr:hover { background: #283548; }
    .badge { padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-block; }
    .badge-call { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid #f59e0b; }
    .badge-progress { background: rgba(96, 165, 250, 0.2); color: #93c5fd; border: 1px solid #60a5fa; }
    .badge-closed { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981; }
    .badge-rejected { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #ef4444; }
    .city-tag { background: #334155; color: #e2e8f0; padding: 2px 8px; border-radius: 6px; font-size: 12px; }
    .live-dot { width: 10px; height: 10px; background: #10b981; border-radius: 50%; display: inline-block; animation: pulse 2s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1><span class="live-dot"></span> Darkemi Digital Agency - Live Leads & Deals Dashboard</h1>
      <div class="sub">Hem Singh Sir के लिए लाइव लीड्स और डील ट्रैकर (ऑटो-रिफ्रेश हर 15 सेकंड)</div>
    </div>
    <div style="text-align: right; color: #94a3b8; font-size: 13px;">
      फ़ाइल: <b>leads.csv</b> | कुल दर्ज: <b>${total}</b>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card card-total">
      <div class="stat-label">कुल लीड्स</div>
      <div class="stat-num" style="color: #38bdf8;">${total}</div>
    </div>
    <div class="stat-card card-call">
      <div class="stat-label">कॉल करनी है (Ready for Call)</div>
      <div class="stat-num" style="color: #f59e0b;">${readyForCall}</div>
    </div>
    <div class="stat-card card-progress">
      <div class="stat-label">बातचीत जारी (In Progress)</div>
      <div class="stat-num" style="color: #60a5fa;">${inProgress}</div>
    </div>
    <div class="stat-card card-closed">
      <div class="stat-label">सफल / क्लोज डील</div>
      <div class="stat-num" style="color: #10b981;">${closed}</div>
    </div>
    <div class="stat-card card-rejected">
      <div class="stat-label">रिजेक्टेड / मिसमैच</div>
      <div class="stat-num" style="color: #ef4444;">${rejected}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>समय</th>
        <th>फोन नंबर</th>
        <th>ग्राहक का नाम</th>
        <th>शहर / लोकेशन</th>
        <th>कैटेगरी</th>
        <th>गाड़ी / सर्विस</th>
        <th>बजट / कीमत</th>
        <th>डील स्थिति</th>
        <th>अंतिम रिमार्क्स / निष्कर्ष</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="9" style="text-align: center; color: #94a3b8;">अभी कोई लीड दर्ज नहीं है।</td></tr>'}
    </tbody>
  </table>
</body>
</html>
    `;
    fs.writeFileSync(DASHBOARD_HTML_PATH, html, 'utf-8');
  } catch (err) {
    console.error('Error rendering dashboard.html:', err.message);
  }
}

// Get Data Sheet summary / stats for Hem Singh Sir on WhatsApp
function getLeadStats() {
  initStorage();

  try {
    const data = JSON.parse(fs.readFileSync(LEADS_JSON_PATH, 'utf-8'));
    const total = data.length;

    let readyForCall = 0;
    let inProgress = 0;
    let closed = 0;
    let rejected = 0;

    data.forEach(item => {
      const s = (item.dealStatus || '').toLowerCase();
      if (s.includes('call') || s.includes('ready')) readyForCall++;
      else if (s.includes('closed') || s.includes('booked')) closed++;
      else if (s.includes('rejected') || s.includes('cancel')) rejected++;
      else inProgress++;
    });

    // Last 3-4 leads with details
    const recent = data.slice(-4).reverse();
    let recentText = '';
    if (recent.length > 0) {
      recentText = '\n\n📋 *हालिया लीड्स व डील स्थिति:*\n' + recent.map((l, i) => {
        const name = (l.customerName && l.customerName !== 'ग्राहक') ? l.customerName : l.phoneNumber;
        const city = (l.cityLocation && l.cityLocation !== 'पता नहीं') ? l.cityLocation : 'स्थान N/A';
        const work = l.serviceOrModel || l.serviceOrDetails || 'सामान्य पूछताछ';
        const budget = l.budgetOrPrice || 'N/A';
        const status = l.dealStatus || 'In Progress';
        return `${i + 1}. *${name}* (${city})\n   • काम: ${work} | बजट: ${budget}\n   • स्थिति: *${status}*`;
      }).join('\n');
    }

    return `📊 *हेम सिंह सर, यह रही आपकी लाइव डील व लीड रिपोर्ट:*\n\n` +
           `• *कुल लीड्स:* ${total}\n` +
           `• 📞 *कॉल करनी है (Ready for Call):* ${readyForCall}\n` +
           `• ⏳ *बातचीत जारी (In Progress):* ${inProgress}\n` +
           `• ✅ *सफल/क्लोज डील:* ${closed}\n` +
           `• ❌ *रिजेक्टेड/कैंसिल:* ${rejected}` +
           `${recentText}\n\n` +
           `📁 *देखने के 2 आसान तरीके:*\n` +
           `1. अपने कंप्यूटर में *dashboard.html* खोलें (लाइव स्क्रीन दिखेगी)\n` +
           `2. या एक्सेल में *leads.csv* फाइल खोलकर पूरा विवरण देखें।`;
  } catch (err) {
    return 'डेटा शीट रिपोर्ट लोड करने में असमर्थ। कृपया leads.csv फाइल चेक करें।';
  }
}

module.exports = {
  initStorage,
  saveLead,
  getLeadStats,
  renderDashboard
};
